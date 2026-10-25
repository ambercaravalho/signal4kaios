/* Pairing auth. The gateway issues a short-lived 8-digit pairing code (printed to its log on first run, or by `npm run pair`); a phone trades it once for a long-lived device token. Only SHA-256 hashes of codes and tokens are stored. Every app request then carries the token (HTTP Bearer header, or the WebSocket subprotocol) and is checked with verify(). */

import * as crypto from 'crypto';
import { db } from './db';
import * as buffer from './buffer';

export const CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const THROTTLE_MAX = 10;
const LAST_SEEN_EVERY_MS = 60 * 1000;
const MAX_NAME_LEN = 64;

db.exec(
  'CREATE TABLE IF NOT EXISTS devices (' +
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,' +
  '  name TEXT NOT NULL,' +
  '  token_hash TEXT NOT NULL UNIQUE,' +
  '  created_at INTEGER NOT NULL,' +
  '  last_seen INTEGER NOT NULL' +
  ');' +
  'CREATE TABLE IF NOT EXISTS pairing_codes (' +
  '  code_hash TEXT PRIMARY KEY,' +
  '  expires_at INTEGER NOT NULL,' +
  '  attempts INTEGER NOT NULL DEFAULT 0' +
  ');'
);

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/* Digits only, so "1234-5678" and "1234 5678" both match. */
export function normalizeCode(code: string): string {
  return String(code || '').replace(/\D/g, '');
}

export function formatCode(code: string): string {
  return code.slice(0, 4) + '-' + code.slice(4);
}

function cleanName(name: unknown): string {
  const s = String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_NAME_LEN);
  return s || 'KaiOS phone';
}

const deleteCodes = db.prepare('DELETE FROM pairing_codes');
const deleteDeadCodes = db.prepare(
  'DELETE FROM pairing_codes WHERE expires_at <= ? OR attempts >= ?'
);
const insertCode = db.prepare(
  'INSERT INTO pairing_codes (code_hash, expires_at, attempts) VALUES (?, ?, 0)'
);
const selectCode = db.prepare(
  'SELECT code_hash FROM pairing_codes WHERE code_hash = ? AND expires_at > ? AND attempts < ?'
);
const deleteCode = db.prepare('DELETE FROM pairing_codes WHERE code_hash = ?');
const bumpAttempts = db.prepare(
  'UPDATE pairing_codes SET attempts = attempts + 1 WHERE expires_at > ?'
);
const insertDevice = db.prepare(
  'INSERT INTO devices (name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?)'
);
const selectDevice = db.prepare('SELECT id FROM devices WHERE token_hash = ?');
const touchDevice = db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?');
const deleteDevice = db.prepare('DELETE FROM devices WHERE id = ?');
const selectDevices = db.prepare(
  'SELECT id, name, created_at, last_seen FROM devices ORDER BY id'
);
const countDevices = db.prepare('SELECT COUNT(*) AS n FROM devices');

/* Issue a fresh pairing code, replacing any outstanding one. Returns the 8 plain digits; only their hash is stored. */
export function issueCode(now: number = Date.now()): { code: string; expiresAt: number } {
  const code = String(crypto.randomInt(0, 100000000)).padStart(8, '0');
  const expiresAt = now + CODE_TTL_MS;
  db.transaction(function () {
    deleteCodes.run();
    insertCode.run(sha256(code), expiresAt);
  })();
  return { code: code, expiresAt: expiresAt };
}

export interface Paired {
  id: number;
  token: string;
}

/* Trade a pairing code for a new device token. A wrong code counts against every outstanding code, so MAX_CODE_ATTEMPTS misses burn it. */
export const redeem = db.transaction(function (
  code: string,
  name: unknown,
  now: number = Date.now()
): Paired | null {
  deleteDeadCodes.run(now, MAX_CODE_ATTEMPTS);
  const digits = normalizeCode(code);
  const hash = sha256(digits);
  const hit = digits.length === 8 ? selectCode.get(hash, now, MAX_CODE_ATTEMPTS) : undefined;
  if (!hit) {
    bumpAttempts.run(now);
    deleteDeadCodes.run(now, MAX_CODE_ATTEMPTS);
    return null;
  }
  deleteCode.run(hash);
  const token = crypto.randomBytes(32).toString('hex');
  const info = insertDevice.run(cleanName(name), sha256(token), now, now);
  return { id: Number(info.lastInsertRowid), token: token };
});

const lastTouched = new Map<number, number>();

/* Resolve a device token to its device id, or null. Lookup is by hash, so the plain token is never compared or stored. */
export function verify(token: string | null | undefined, now: number = Date.now()): number | null {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = selectDevice.get(sha256(token)) as { id: number } | undefined;
  if (!row) return null;
  const prev = lastTouched.get(row.id) || 0;
  if (now - prev > LAST_SEEN_EVERY_MS) {
    lastTouched.set(row.id, now);
    touchDevice.run(now, row.id);
  }
  return row.id;
}

const selectDeviceById = db.prepare('SELECT id FROM devices WHERE id = ?');

/* Whether a device is still paired (used to drop sockets after a CLI revoke, which runs in another process). */
export function exists(id: number): boolean {
  return !!selectDeviceById.get(id);
}

/* Unpair a device and drop its push subscriptions. */
export function revoke(id: number): boolean {
  lastTouched.delete(id);
  buffer.removeSubsForDevice(id);
  return deleteDevice.run(id).changes > 0;
}

export interface DeviceInfo {
  id: number;
  name: string;
  created_at: number;
  last_seen: number;
}

export function list(): DeviceInfo[] {
  return selectDevices.all() as DeviceInfo[];
}

export function hasDevices(): boolean {
  const row = countDevices.get() as { n: number };
  return row.n > 0;
}

/* The operator-facing banner for a pairing code. This (stdout of the gateway or the CLI) is the only place a code is ever printed. */
export function pairingBanner(code: string, expiresAt: number): string {
  const mins = Math.round((expiresAt - Date.now()) / 60000);
  return [
    '',
    '============================================================',
    '  Signal4KaiOS pairing code:  ' + formatCode(code),
    '  Enter it in the app (with this gateway\'s address).',
    '  Valid for ' + mins + ' minutes, single use.',
    '  New code: docker compose exec gateway npm run pair',
    '============================================================',
    ''
  ].join('\n');
}

/* Extract the token from "Authorization: Bearer <token>". */
export function bearer(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  const m = h ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  return m ? m[1] : null;
}

/* Per-IP limit on pairing attempts (in memory; resets on restart). Returns true if this attempt is allowed. */
const attemptsByIp = new Map<string, { start: number; count: number }>();

export function allowPairAttempt(ip: string, now: number = Date.now()): boolean {
  const cur = attemptsByIp.get(ip);
  if (!cur || now - cur.start > THROTTLE_WINDOW_MS) {
    attemptsByIp.set(ip, { start: now, count: 1 });
    return true;
  }
  cur.count += 1;
  return cur.count <= THROTTLE_MAX;
}
