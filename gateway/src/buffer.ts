/* Durable store (SQLite via better-sqlite3): the buffered receive frames with a
   per-number cursor (seq), push subscriptions, known numbers, and a small
   pending-notification queue for payloadless "tickle" pushes. */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(
  'CREATE TABLE IF NOT EXISTS frames (' +
  '  number TEXT NOT NULL,' +
  '  seq INTEGER NOT NULL,' +
  '  received_at INTEGER NOT NULL,' +
  '  json TEXT NOT NULL,' +
  '  PRIMARY KEY (number, seq)' +
  ');' +
  'CREATE TABLE IF NOT EXISTS counters (' +
  '  number TEXT PRIMARY KEY,' +
  '  next_seq INTEGER NOT NULL' +
  ');' +
  'CREATE TABLE IF NOT EXISTS subs (' +
  '  endpoint TEXT PRIMARY KEY,' +
  '  number TEXT NOT NULL,' +
  '  sub_json TEXT NOT NULL,' +
  '  created_at INTEGER NOT NULL' +
  ');' +
  'CREATE TABLE IF NOT EXISTS numbers (' +
  '  number TEXT PRIMARY KEY,' +
  '  created_at INTEGER NOT NULL' +
  ');' +
  'CREATE TABLE IF NOT EXISTS pending (' +
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,' +
  '  number TEXT NOT NULL,' +
  '  json TEXT NOT NULL,' +
  '  created_at INTEGER NOT NULL' +
  ');' +
  'CREATE INDEX IF NOT EXISTS idx_pending_number ON pending(number);'
);

const getCounter = db.prepare('SELECT next_seq FROM counters WHERE number = ?');
const setCounter = db.prepare(
  'INSERT INTO counters (number, next_seq) VALUES (?, ?) ' +
  'ON CONFLICT(number) DO UPDATE SET next_seq = excluded.next_seq'
);
const insertFrame = db.prepare(
  'INSERT INTO frames (number, seq, received_at, json) VALUES (?, ?, ?, ?)'
);
const selectSince = db.prepare(
  'SELECT seq, json FROM frames WHERE number = ? AND seq > ? ORDER BY seq ASC'
);
const selectMaxSeq = db.prepare(
  'SELECT MAX(seq) AS m FROM frames WHERE number = ?'
);
const pruneStmt = db.prepare(
  'DELETE FROM frames WHERE number = ? AND seq <= ' +
  '(SELECT seq FROM frames WHERE number = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)'
);

const nextSeqTx = db.transaction((number: string): number => {
  const row = getCounter.get(number) as { next_seq: number } | undefined;
  const seq = row ? row.next_seq : 1;
  setCounter.run(number, seq + 1);
  return seq;
});

export interface StoredFrame {
  seq: number;
  json: string;
}

/* Assign the next per-number seq, store the raw frame text, prune to the
   retention cap, and return the assigned seq. */
export function addFrame(number: string, json: string): number {
  const seq = nextSeqTx(number);
  insertFrame.run(number, seq, Date.now(), json);
  pruneStmt.run(number, number, config.retentionPerNumber);
  return seq;
}

export function framesSince(number: string, since: number): StoredFrame[] {
  return selectSince.all(number, since) as StoredFrame[];
}

export function maxSeq(number: string): number {
  const row = selectMaxSeq.get(number) as { m: number | null } | undefined;
  return row && row.m != null ? row.m : 0;
}

/* ---- push subscriptions ---- */

const upsertSub = db.prepare(
  'INSERT INTO subs (endpoint, number, sub_json, created_at) VALUES (?, ?, ?, ?) ' +
  'ON CONFLICT(endpoint) DO UPDATE SET number = excluded.number, ' +
  'sub_json = excluded.sub_json'
);
const deleteSub = db.prepare('DELETE FROM subs WHERE endpoint = ?');
const selectSubs = db.prepare('SELECT sub_json FROM subs WHERE number = ?');

export function addSub(number: string, subscription: unknown): void {
  const endpoint = (subscription as { endpoint?: string }).endpoint;
  if (!endpoint) return;
  upsertSub.run(endpoint, number, JSON.stringify(subscription), Date.now());
}

export function removeSubByEndpoint(endpoint: string): void {
  deleteSub.run(endpoint);
}

export function subsFor(number: string): unknown[] {
  const rows = selectSubs.all(number) as { sub_json: string }[];
  return rows.map((r) => JSON.parse(r.sub_json));
}

/* ---- known numbers (to resume upstream receivers on restart) ---- */

const upsertNumber = db.prepare(
  'INSERT INTO numbers (number, created_at) VALUES (?, ?) ' +
  'ON CONFLICT(number) DO NOTHING'
);
const selectNumbers = db.prepare('SELECT number FROM numbers');

export function addNumber(number: string): void {
  upsertNumber.run(number, Date.now());
}

export function allNumbers(): string[] {
  const rows = selectNumbers.all() as { number: string }[];
  return rows.map((r) => r.number);
}

/* ---- pending notifications (tickle fallback) ---- */

const insertPending = db.prepare(
  'INSERT INTO pending (number, json, created_at) VALUES (?, ?, ?)'
);
const selectPending = db.prepare('SELECT id, json FROM pending WHERE number = ?');
const deletePending = db.prepare('DELETE FROM pending WHERE id = ?');

export function addPending(number: string, note: unknown): void {
  insertPending.run(number, JSON.stringify(note), Date.now());
}

/* Return and clear all pending notes for a number. */
export function takePending(number: string): unknown[] {
  const rows = selectPending.all(number) as { id: number; json: string }[];
  const takeTx = db.transaction((items: { id: number; json: string }[]) => {
    const out: unknown[] = [];
    for (const it of items) {
      out.push(JSON.parse(it.json));
      deletePending.run(it.id);
    }
    return out;
  });
  return takeTx(rows);
}
