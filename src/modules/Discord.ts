import { Client, GatewayIntentBits, Message } from 'discord.js';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

// Load environment variables
dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNELS_ID = process.env.CHANNELS_ID?.split(',') || [];
const WEBHOOKS_URL = process.env.WEBHOOKS_URL?.split(',') || [];

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`Bot is online as ${client.user?.tag}`);
});

client.on('messageCreate', async (message: Message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Only forward from specific channels
  if (!CHANNELS_ID.includes(message.channel.id)) return;

  console.log(`Forwarding message from ${message.author.username}`);
  await forwardMessage(message);
});

async function forwardMessage(message: Message) {
  const content = message.content;
  const username = message.author.username;
  const avatar_url = message.author.displayAvatarURL();

  const attachments = Array.from(message.attachments.values());

  for (const webhookUrl of WEBHOOKS_URL) {
    const body: any = {
      username,
      avatar_url,
      content,
    };

    // Include image previews if attachments exist
    if (attachments.length > 0) {
      body.embeds = attachments.map((a) => ({
        image: { url: a.url },
        footer: { text: a.name || 'Attachment' }
      }));
    }

    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error(`Failed to send to webhook ${webhookUrl}:`, err);
    }
  }
}

client.login(DISCORD_TOKEN);
