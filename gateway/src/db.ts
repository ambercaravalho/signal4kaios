/* The gateway's single SQLite handle (better-sqlite3). WAL mode lets the CLI (npm run pair / devices / revoke) share the file with the running server. */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
