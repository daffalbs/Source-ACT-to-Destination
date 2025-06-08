import dotenv from "dotenv";
dotenv.config();

import process from "node:process";
import { setInterval } from "node:timers";
import Websocket from "ws";

import {
  WebhookClient,
  GatewayDispatchEvents,
  GatewayOpcodes,
} from "discord.js";

import type {
  APIAttachment,
  APIStickerItem,
  GatewayReceivePayload,
} from "discord.js";
import type { Things, WebsocketTypes } from "../typings/index.js";
import type { SenderProfile } from "../typings/index.js";

import { cleanMessage } from "../utils/functions/cleanMessage.js";
import { enableAttachment } from "../utils/env.js";
import logger from "../utils/logger.js";

// Setup configs and mappings
const processedMessages = new Set<string>();
const enableBotIndicator = process.env.ENABLE_BOT_INDICATOR === "yes";
const useWebhookProfile = process.env.USE_WEBHOOK_PROFILE === "yes";
const discordToken = process.env.DISCORD_TOKEN;

const channelWebhookMap = new Map<string, string>();
const channelsId = (process.env.CHANNELS_ID || "")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id);
const webhooksUrl = (process.env.WEBHOOKS_URL || "")
  .split(",")
  .map((url) => url.trim());

channelsId.forEach((channelId, index) => {
  if (webhooksUrl[index]) channelWebhookMap.set(channelId, webhooksUrl[index]);
});

// Helper: Send message via webhook
export const executeWebhook = async (things: Things): Promise<void> => {
  try {
    const wsClient = new WebhookClient({ url: things.url });
    const avatarURL = things.profile.avatar
      ? `https://cdn.discordapp.com/avatars/${things.profile.id}/${things.profile.avatar}.${things.profile.avatar.startsWith("a_") ? "gif" : "jpg"}`
      : `https://cdn.discordapp.com/embed/avatars/${(BigInt(things.profile.id) >> 22n) % 6n}.png`;

    await wsClient.send({
      username: useWebhookProfile ? things.profile.globalName || things.profile.username : things.username,
      avatarURL,
      content: things.content,
      embeds: things.embeds,
      files: things.files,
    });
  } catch (error) {
    logger.error("Failed to execute webhook:", error instanceof Error ? error.message : String(error));
    throw error;
  }
};

// WebSocket resume session tracking
let ws: WebsocketTypes;
let resumeData = { sessionId: "", resumeGatewayUrl: "", seq: 0 };
let authenticated = false;

// Start Discord Gateway listener
export const listen = (): void => {
  const gatewayURL = resumeData.resumeGatewayUrl
    ? resumeData.resumeGatewayUrl
    : "wss://gateway.discord.gg/?v=10&encoding=json";

  ws = new Websocket(gatewayURL);

  ws.on("open", () => {
    logger.info("Connected to Discord Gateway.");
    if (resumeData.sessionId) {
      ws.send(JSON.stringify({
        op: GatewayOpcodes.Resume,
        d: {
          token: discordToken,
          session_id: resumeData.sessionId,
          seq: resumeData.seq,
        },
      }));
    }
  });

  ws.on("close", () => {
    logger.warning("WebSocket closed. Reconnecting...");
    setTimeout(() => listen(), 5000);
  });

  ws.on("error", (error) => {
    logger.error("WebSocket error:", error);
    setTimeout(() => listen(), 5000);
  });

  ws.on("message", async (data: string) => {
    const payload = JSON.parse(data) as GatewayReceivePayload;
    const { op, t: eventType, d, s } = payload;
    resumeData.seq = s ?? resumeData.seq;

    switch (op) {
      case GatewayOpcodes.Hello: {
        logger.info("Hello received. Sending heartbeat...");
        const interval = d.heartbeat_interval;

        setInterval(() => {
          ws.send(JSON.stringify({ op: GatewayOpcodes.Heartbeat, d: resumeData.seq }));
        }, interval);

        break;
      }

      case GatewayOpcodes.Heartbeat:
        ws.send(JSON.stringify({ op: GatewayOpcodes.Heartbeat, d: resumeData.seq }));
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
                  os: "android",
                  browser: "dcm",
                  device: "dcm",
                },
                intents: 37408,
              },
            }),
          );
          logger.info("Authenticating...");
        }
        break;

      case GatewayOpcodes.Dispatch: {
        if (eventType === GatewayDispatchEvents.Ready) {
          resumeData = {
            sessionId: d.session_id,
            resumeGatewayUrl: `${d.resume_gateway_url}?v=10&encoding=json`,
            seq: resumeData.seq,
          };
          logger.info(`Logged in as ${d.user.username}#${d.user.discriminator}`);
        }

        if (eventType === GatewayDispatchEvents.MessageCreate) {
          const { channel_id, id, content, attachments, embeds, sticker_items, author } = d;

          if (!channelWebhookMap.has(channel_id) || processedMessages.has(id)) return;
          processedMessages.add(id);

          const webhookUrl = channelWebhookMap.get(channel_id)!;
          const ext = author.avatar?.startsWith("a_") ? "gif" : "jpg";
          const avatarURL = author.avatar
            ? `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.${ext}`
            : `https://cdn.discordapp.com/embed/avatars/${(BigInt(author.id) >> 22n) % 6n}.png`;

          const profile: SenderProfile = {
            id: author.id,
            username: author.username,
            discriminator: author.discriminator === "0" ? null : `#${author.discriminator}`,
            avatar: author.avatar,
            bot: !!author.bot,
            globalName: author.global_name,
          };

          const things: Things = {
            profile,
            avatarURL,
            content: content ? cleanMessage(content) : "** **\n",
            url: webhookUrl,
            username: `${author.username}${profile.discriminator || ""}`,
          };

          if (embeds.length) {
            things.embeds = embeds;
          } else if (sticker_items) {
            things.files = sticker_items.map(
              (sticker: APIStickerItem) => ({
                attachment: `https://media.discordapp.net/stickers/${sticker.id}.webp`,
                name: `${sticker.id}.webp`,
              })
            );
          } else if (attachments.length && enableAttachment) {
            things.files = attachments.map((a: APIAttachment) => ({
              attachment: a.url,
              name: a.filename,
              description: a.description,
            }));
          }

          await executeWebhook(things);
        }

        break;
      }

      case GatewayOpcodes.Reconnect:
        logger.info("Received reconnect opcode. Reconnecting...");
        listen();
        break;

      case GatewayOpcodes.InvalidSession:
        logger.warning("Invalid session.");
        d ? listen() : process.exit(1);
        break;

      default:
        logger.warning(`Unhandled opcode: ${op}`);
    }
  });
};
