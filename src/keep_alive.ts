import http from 'http';
import logger from './utils/logger.js';
import { webhooksUrl } from './utils/env.js';

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.write("I'm alive");
  res.end();
});

async function sendDiscordNotification(message: string): Promise<void> {
  try {
    const webhook = webhooksUrl[0];
    if (!webhook) return;

    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🚨 **Server Status Alert**: ${message}`,
        username: 'Server Monitor'
      })
    });
  } catch (error) {
    logger.error('Failed to send Discord notification:', error instanceof Error ? error.message : String(error));
  }
}

let consecutiveFailures = 0;
const MAX_FAILURES = 3;

export function startKeepAlive(): void {
  setInterval(async () => {
    try {
      const response = await fetch('http://0.0.0.0:3000');
      if (response.ok) {
        if (consecutiveFailures > 0) {
          await sendDiscordNotification('Server is back online! 🟢');
          consecutiveFailures = 0;
        }
        logger.debug('Keep-alive ping successful');
      } else {
        throw new Error(`Server responded with status ${response.status}`);
      }
    } catch (error) {
      consecutiveFailures++;
      logger.error('Keep-alive error:', error instanceof Error ? error.message : String(error));

      if (consecutiveFailures >= MAX_FAILURES) {
        await sendDiscordNotification('Server is down! ⛔ Attempting restart...');
        startServer();
      }
    }
  }, 120000);

  startServer();
}

function startServer(): void {
  if (server.listening) {
    server.close();
  }

  const retryStart = () => {
    server.listen(3000, '0.0.0.0', () => {
      logger.info('Keep-alive server is running on port 3000');
    });
  };

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.warning('Port 8080 is in use, waiting 5 seconds to retry...'); // Changed port here
      setTimeout(() => {
        server.close();
        retryStart();
      }, 5000);
    } else {
      logger.error('Server start failed:', error.message);
    }
  });

  retryStart();
}

export default server;