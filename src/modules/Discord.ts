// src/modules/Discord.ts

import dotenv from "dotenv";
dotenv.config();

import process from "node:process";
import { setInterval } from "node:timers";
import Websocket from "ws";
import {
  GatewayDispatchEvents,
  GatewayOpcodes,
  WebhookClient,
} from "discord.js";

import type {
  APIAttachment,
  APIStickerItem,
  GatewayReceivePayload,
} from "discord.js";
import type { SenderProfile } from "../typings/index.js";
import type { DiscordWebhook, Things, WebsocketTypes } from "../typings/index.js";

import { cleanMessage } from "../utils/functions/cleanMessage.js";
import { enableAttachment } from "../utils/env.js";
import logger from "../utils/logger.js";

// === Environment Setup ===

const discordToken = process.env.DISCORD_TOKEN;
const enableBotIndicator = process.env.ENABLE_BOT_INDICATOR === "yes";
const useWebhookProfile = process.env.USE_WEBHOOK_PROFILE === "yes";

const channelsId = [...new Set((process.env.CHANNELS_ID || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean))];

const webhooksUrl = (process.env.WEBHOOKS_URL || "")
  .split(",")
  .map((url) => url.trim());

const channelWebhookMap = new Map<string, string>();
channelsId.forEach((channelId, index) => {
  if (index < webhooksUrl.length) {
    channelWebhookMap.set(channelId, webhooksUrl[index]);
  }
});

const processedMessages = new Set<string>();

// === Webhook Execution ===

export const executeWebhook = async (things: Things): Promise<void> => {
  try {
    const wsClient = new WebhookClient({ url: things.url });

    const profileData = {
      username: things.profile.globalName || things.profile.username,
      avatarURL: things.profile.avatar
        ? `https://cdn.discordapp.com/avatars/${things.profile.id}/${things.profile.avatar}.${things.profile.avatar?.startsWith("a_") ? "gif" : "jpg"}`
        : `https://cdn.discordapp.com/embed/avatars/${(BigInt(things.profile.id) >> 22n) % 6n}.png`,
    };

    await wsClient.send({
      content: things.content,
      username: profileData.username,
      avatarURL: profileData.avatarURL,
      embeds: things.embeds,
      files: things.files,
    });
  } catch (error) {
    logger.error("Webhook error:", error instanceof Error ? error.message : String(error));
  }
};

// === WebSocket Setup ===

let ws: WebsocketTypes;
let resumeData = {
  sessionId: "",
  resumeGatewayUrl: "",
  seq: 0,
};
let authenticated = false;

export const listen = (): void => {
  const gatewayUrl = resumeData.sessionId
    ? resumeData.resumeGatewayUrl
    : "wss://gateway.discord.gg/?v=10&encoding=json";

  ws = new Websocket(gatewayUrl);

  ws.on("open", () => {
    logger.info("Connected to Discord Gateway.");

    if (resumeData.sessionId) {
      logger.info("Resuming session...");
      ws.send(
        JSON.stringify({
          op: GatewayOpcodes.Resume,
          d: {
            token: discordToken,
            session_id: resumeData.sessionId,
            seq: resumeData.seq,
          },
        })
      );
    }
  });

  ws.on("close", () => {
    logger.warning("WebSocket closed. Reconnecting in 5s...");
    setTimeout(listen, 5000);
  });

  ws.on("error", (err) => {
    logger.error("WebSocket error:", err);
    setTimeout(listen, 5000);
  });

  ws.on("message", async (raw: string) => {
    const payload: GatewayReceivePayload = JSON.parse(raw);
    const { op, t, d, s } = payload;

    resumeData.seq = s ?? resumeData.seq;

    switch (op) {
      case GatewayOpcodes.Hello:
        logger.info("Hello received. Starting heartbeat...");
        ws.send(JSON.stringify({ op: 1, d: s }));
        setInterval(() => {
          ws.send(JSON.stringify({ op: 1, d: s }));
        }, d.heartbeat_interval);
        break;

      case GatewayOpcodes.HeartbeatAck:
        if (!authenticated) {
          authenticated = true;
          ws.send(
            JSON.stringify({
              op: GatewayOpcodes.Identify,
              d: {
                token: discordToken,
                properties: {
                  os: "linux",
                  browser: "dcm",
                  device: "dcm",
                },
                intents: 37408,
              },
            })
          );
          logger.info("Authenticating...");
        }
        break;

      case GatewayOpcodes.Dispatch:
        if (t === GatewayDispatchEvents.Ready) {
          resumeData = {
            sessionId: d.session_id,
            resumeGatewayUrl: `${d.resume_gateway_url}?v=10&encoding=json`,
            seq: s,
          };
          logger.info(`Logged in as ${d.user.username}`);
        }

        if (
          t === GatewayDispatchEvents.MessageCreate &&
          channelsId.includes(d.channel_id) &&
          !processedMessages.has(d.id)
        ) {
          processedMessages.add(d.id);

          const webhookUrl = channelWebhookMap.get(d.channel_id);
          if (!webhookUrl) return;

          const {
            content,
            attachments = [],
            embeds = [],
            sticker_items = [],
            author,
          } = d;

          const ext = author.avatar?.startsWith("a_") ? "gif" : "jpg";

          const profile: SenderProfile = {
            id: author.id,
            username: author.username,
            discriminator: author.discriminator !== "0" ? `#${author.discriminator}` : null,
            avatar: author.avatar,
            bot: !!author.bot,
            globalName: author.global_name,
          };

          const things: Things = {
            profile,
            url: webhookUrl,
            username: `${author.username}${profile.discriminator || ""}`,
            avatarURL: author.avatar
              ? `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.${ext}`
              : `https://cdn.discordapp.com/embed/avatars/${(BigInt(author.id) >> 22n) % 6n}.png`,
            content: content ? cleanMessage(content) : "** **",
          };

          // Prioritize in order: embeds, stickers, attachments
          if (embeds.length > 0) {
            things.embeds = embeds;
          } else if (sticker_items.length > 0) {
            things.files = sticker_items.map((s: APIStickerItem) => `https://media.discordapp.net/stickers/${s.id}.webp`);
          }

          if (attachments.length > 0 && enableAttachment) {
            things.files = attachments.map((file: APIAttachment) => ({
              attachment: file.url,
              name: file.filename,
              description: file.description,
            }));
          }

          await executeWebhook(things);
        }
        break;

      case GatewayOpcodes.Reconnect:
        logger.info("Reconnect requested by server.");
        listen();
        break;

      case GatewayOpcodes.InvalidSession:
        logger.warning("Invalid session.");
        d ? listen() : process.exit(1);
        break;

      default:
        logger.debug("Unhandled opcode:", op);
        break;
    }
  });
};
