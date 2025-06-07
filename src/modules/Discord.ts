import { Client, GatewayIntentBits, WebhookClient, TextChannel } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNELS_ID = process.env.CHANNELS_ID?.split(',') || [];
const WEBHOOKS_URL = process.env.WEBHOOKS_URL?.split(',') || [];

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const webhooks: WebhookClient[] = WEBHOOKS_URL.map((url) => new WebhookClient({ url }));

client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user?.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (CHANNELS_ID.includes(message.channel.id)) {
    const content = `**${message.author.tag}**: ${message.content}`;
    console.log(`[Relay] ${content}`);

    // Kirim ke semua webhook
    for (const webhook of webhooks) {
      try {
        await webhook.send({
          content,
          username: message.author.username,
          avatarURL: message.author.displayAvatarURL(),
        });
      } catch (err) {
        console.error('[Webhook Error]', err);
      }
    }
  }
});

client.login(DISCORD_TOKEN);
