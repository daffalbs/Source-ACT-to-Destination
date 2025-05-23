import { listen } from "./modules/Discord.js";
import { startKeepAlive } from './keep_alive.js';

startKeepAlive();
listen();
