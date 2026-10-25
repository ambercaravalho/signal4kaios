/* The gateway's single SQLite handle (better-sqlite3). WAL mode lets the CLI (npm run pair / devices / revoke) share the file with the running server. */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(
  'CREATE TABLE IF NOT EXISTS settings (' +
  '  key TEXT PRIMARY KEY,' +
  '  value TEXT NOT NULL' +
  ');'
);

const selectSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const upsertSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ' +
  'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

/* Small key/value store for gateway state that must survive restarts (e.g. generated VAPID keys). */
export function getSetting(key: string): string | null {
  const row = selectSetting.get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  upsertSetting.run(key, value);
}
