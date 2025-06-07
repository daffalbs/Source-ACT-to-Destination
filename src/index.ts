import dotenv from 'dotenv';
dotenv.config();

// now process.env.WEBHOOK_URL, process.env.DISCORD_TOKEN, etc. are available

import { listen } from "./modules/Discord.js";
import { startKeepAlive } from './keep_alive.js';

startKeepAlive();
listen();
