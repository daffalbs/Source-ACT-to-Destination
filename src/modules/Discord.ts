// src/modules/Discord.ts
import dotenv from 'dotenv';
dotenv.config();

import process from "node:process";
import { setInterval } from "node:timers";
import { cleanMessage } from "../utils/functions/cleanMessage.js";
import type {
    APIAttachment,
    APIStickerItem,
    GatewayReceivePayload,
} from "discord.js";
import type { SenderProfile } from "../typings/index.js";
import {
    WebhookClient,
    GatewayDispatchEvents,
    GatewayOpcodes,
} from "discord.js";
import { enableAttachment } from "../utils/env.js";
import Websocket from "ws";
import type {
    DiscordWebhook,
    Things, 
    WebsocketTypes,
} from "../typings/index.js";
import logger from "../utils/logger.js";

// Parse channel and webhook URLs from env
const channelWebhookMap = new Map();
const channelsId = [...new Set((process.env.CHANNELS_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(id => id.length > 0))];
const webhooksUrl = (process.env.WEBHOOKS_URL || "")
    .split(",")
    .map((url) => url.trim());

channelsId.forEach((channelId, index) => {
    if (index < webhooksUrl.length) {
        channelWebhookMap.set(channelId, webhooksUrl[index]);
    }
});

const processedMessages = new Set<string>();
const enableBotIndicator = process.env.ENABLE_BOT_INDICATOR === "yes";
const useWebhookProfile = process.env.USE_WEBHOOK_PROFILE === "yes";
const discordToken = process.env.DISCORD_TOKEN;

const headers = {
    "Content-Type": "application/json",
    Authorization: `Bot ${discordToken}`,
};

export const executeWebhook = async (things: Things): Promise<void> => {
    try {
        const wsClient = new WebhookClient({ url: things.url });
        const profileData = {
            username: things.profile.globalName || things.profile.username,
            avatarURL: `https://cdn.discordapp.com/avatars/${things.profile.id}/${things.profile.avatar}.${things.profile.avatar?.startsWith("a_") ? "gif" : "jpg"}`,
        };

        await wsClient.send({
            ...things,
            username: profileData.username,
            avatarURL: things.profile.avatar ? profileData.avatarURL : `https://cdn.discordapp.com/embed/avatars/${(BigInt(things.profile.id) >> 22n) % 6n}.png`,
            content: things.content,
            embeds: things.embeds,
            files: things.files
        });
    } catch (error) {
        logger.error('Failed to execute webhook:', error instanceof Error ? error.message : String(error));
        // Do not throw to prevent crash loop
    }
};

let ws: WebsocketTypes;
let resumeData = {
    sessionId: "",
    resumeGatewayUrl: "",
    seq: 0,
};
let authenticated = false;

export const listen = (): void => {
    if (resumeData.sessionId && resumeData.resumeGatewayUrl) {
        logger.info("Resuming session...");
        logger.debug(`Session ID: ${resumeData.sessionId}`);
        logger.debug(`Resume Gateway URL: ${resumeData.resumeGatewayUrl}`);
        logger.debug(`Sequence: ${resumeData.seq}`);

        ws = new Websocket(resumeData.resumeGatewayUrl);

        ws.on('open', () => {
            ws.send(JSON.stringify({
                op: 6,
                d: {
                    token: discordToken,
                    session_id: resumeData.sessionId,
                    seq: resumeData.seq,
                },
            }));
        });
    } else {
        ws = new Websocket("wss://gateway.discord.gg/?v=10&encoding=json");
    }

    ws.on("open", () => logger.info("Connected to Discord WSS."));
    ws.on("close", () => {
        logger.warning("WebSocket closed. Reconnecting...");
        setTimeout(() => listen(), 5000);
    });
    ws.on("error", (error) => {
        logger.error("WebSocket error:", error);
        setTimeout(() => listen(), 5000);
    });

    ws.on("message", async (data: string) => {
        const payload: GatewayReceivePayload = JSON.parse(data);
        const { op, d, s, t } = payload;
        resumeData.seq = s ?? resumeData.seq;

        switch (op) {
            case GatewayOpcodes.Hello:
                logger.info("Hello received. Starting heartbeat...");
                ws.send(JSON.stringify({ op: 1, d: s }));
                setInterval(() => {
                    ws.send(JSON.stringify({ op: 1, d: s }));
                    logger.debug("Heartbeat sent.");
                }, d.heartbeat_interval);
                break;

            case GatewayOpcodes.Heartbeat:
                logger.debug("Immediate heartbeat requested.");
                ws.send(JSON.stringify({ op: 1, d: s }));
                break;

            case GatewayOpcodes.HeartbeatAck:
                if (!authenticated) {
                    authenticated = true;
                    ws.send(JSON.stringify({
                        op: 2,
                        d: {
                            token: discordToken,
                            properties: {
                                os: "android",
                                browser: "dcm",
                                device: "dcm",
                            },
                            intents: Number("37408"),
                        },
                    }));
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

                    let ext = "jpg";
                    const {
                        content,
                        attachments,
                        embeds,
                        sticker_items,
                        author,
                    } = d;

                    const {
                        avatar,
                        username,
                        discriminator: discriminatorRaw,
                        id,
                        bot,
                        global_name
                    } = author;

                    const discriminator =
                        discriminatorRaw === "0" ? null : `#${discriminatorRaw}`;

                    if (avatar?.startsWith("a_")) ext = "gif";

                    const profile: SenderProfile = {
                        id,
                        username,
                        discriminator,
                        avatar,
                        bot: !!bot,
                        globalName: global_name
                    };

                    const things: Things = {
                        profile,
                        avatarURL: avatar
                            ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.${ext}`
                            : `https://cdn.discordapp.com/embed/avatars/${(BigInt(id) >> 22n) % 6n}.png`,
                        content: content ? cleanMessage(content) : "** **\n",
                        url: webhookUrl,
                        username: `${username}${discriminator ?? ""}`,
                    };

                    if (embeds.length > 0) {
                        things.embeds = embeds;
                    } else if (sticker_items) {
                        things.files = sticker_items.map(
                            (a: APIStickerItem) =>
                                `https://media.discordapp.net/stickers/${a.id}.webp`
                        );
                    } else if (attachments.length > 0 && enableAttachment) {
                        things.files = attachments.map((a: APIAttachment) => ({
                            attachment: a.url,
                            name: a.filename,
                            description: a.description
                        }));
                    }

                    await executeWebhook(things);
                }
                break;

            case GatewayOpcodes.Reconnect:
                logger.info("Reconnect requested.");
                listen();
                break;

            case GatewayOpcodes.InvalidSession:
                logger.warning("Invalid session.");
                d ? listen() : process.exit(1);
                break;

            default:
                logger.warning("Unhandled opcode:", op);
                break;
        }
    });
};