import './ui-env';
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { signal } from '../src/ui/data/api';
import { config } from '../src/ui/data/config';
import { db } from '../src/ui/data/db';
import * as store from '../src/ui/data/store';
import * as ws from '../src/ui/data/ws';
import { settle } from './helpers';

const ALICE = '+15550001';
const BOB = '+15550002';
const QUEUE_EMPTY = 255;

class FakeSocket {
  readyState = 0;
  binaryType = '';
  acks: number[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason?: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  send(bytes: Uint8Array): void {
    this.acks.push(bytes[0]);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    if (this.onopen) this.onopen({});
  }
  /** A `PUT /api/v1/message` whose request id and envelope are both `id`. */
  deliver(id: number): void {
    this.onmessage!({ data: new Uint8Array([id]).buffer });
  }
  /** The server's response to a keepalive. */
  reply(): void {
    this.onmessage!({ data: new Uint8Array(0).buffer });
  }
  keepalives(): number {
    return this.acks.filter((b) => b === 0).length;
  }
}

const sockets: FakeSocket[] = [];
const current = () => sockets[sockets.length - 1];
const decrypted: Record<number, () => Promise<unknown>> = {};
const message =
  (ts: number, from = ALICE) =>
  async () => ({ envelope: { sourceNumber: from, timestamp: ts, dataMessage: { timestamp: ts, message: 'm' + ts } } });

let preKeyChecks = 0;
const notified: string[] = [];
function showNotifications(on: boolean): void {
  (globalThis as any).document.hidden = on;
  if (on)
    (globalThis as any).Notification = class {
      onclick: unknown = null;
      constructor(_title: string, opts: { tag: string }) {
        notified.push(opts.tag);
      }
      close(): void {}
    };
  else delete (globalThis as any).Notification;
}

describe('the server’s time', () => {
  it('reads X-Signal-Timestamp from a request’s headers, in any case, and nothing else', () => {
    assert.equal(ws.signalTimestamp(['Content-Type:application/x-protobuf', 'X-Signal-Timestamp:1700000000123']), 1700000000123);
    assert.equal(ws.signalTimestamp(['x-signal-timestamp: 1700000000123']), 1700000000123);
    assert.equal(ws.signalTimestamp(['X-Signal-Timestamp:soon']), undefined);
    assert.equal(ws.signalTimestamp(undefined), undefined);
  });
});

describe('acknowledging messages', () => {
  const put = db.putMessage;

  before(async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    config.set({ number: '+15550000', aci: 'aci-me', deviceId: 2, deviceToken: 'test-only' });
    await db.ready();
    const s = signal as any;
    s.decodeWsFrame = (buf: ArrayBuffer) => {
      const bytes = new Uint8Array(buf);
      if (!bytes.length) return { type: 2, response: { id: 0n, status: 200, message: 'OK' } };
      const id = bytes[0];
      if (id === QUEUE_EMPTY) return { type: 1, request: { path: '/api/v1/queue/empty', id: BigInt(id) } };
      return { type: 1, request: { path: '/api/v1/message', body: new Uint8Array([id]), id: BigInt(id) } };
    };
    s.encodeWsAck = (id: bigint) => new Uint8Array([Number(id)]);
    s.encodeWsKeepalive = () => new Uint8Array([0]);
    s.maintainPreKeys = async () => {
      preKeyChecks++;
    };
    s.processIncomingEnvelope = (body: Uint8Array) => decrypted[body[0]]();
    s.net.isPinnedUrl = () => true;
    s.net.openWebSocket = () => {
      const sock = new FakeSocket();
      sockets.push(sock);
      return sock;
    };
    ws.connect();
    current().open();
  });

  after(() => {
    (db as any).putMessage = put;
    showNotifications(false);
    ws.stop();
    mock.timers.reset();
  });

  it('keeps the first offline queue after launch quiet, then notifies again', async () => {
    showNotifications(true);
    notified.length = 0;
    decrypted[20] = message(20000);
    current().deliver(20);
    current().deliver(QUEUE_EMPTY);
    await settle();
    assert.deepEqual(notified, []);
    decrypted[21] = message(21000);
    current().deliver(21);
    await settle();
    assert.deepEqual(notified, [ALICE]);
    showNotifications(false);
    ws.restart();
    current().open();
    current().deliver(QUEUE_EMPTY);
    current().acks.length = 0;
  });

  it('acknowledges only once the message is stored', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (db as any).putMessage = (rec: any) => gate.then(() => put.call(db, rec));
    decrypted[1] = message(61000);
    current().deliver(1);
    await settle();
    assert.deepEqual(current().acks, [], 'not while the write is pending');
    release();
    await settle();
    assert.deepEqual(current().acks, [1]);
    assert.ok(await db.getMessage(ALICE + '|61000|' + ALICE));
    (db as any).putMessage = put;
  });

  it('holds a message the database refused, and acknowledges it once a retry stores it', async () => {
    let warned = 0;
    const off = store.on('save-error', () => warned++);
    (db as any).putMessage = () => Promise.reject(new DOMException('disk full', 'QuotaExceededError'));
    decrypted[2] = message(62000);
    decrypted[3] = message(63000);
    current().deliver(2);
    current().deliver(3);
    await settle();
    assert.deepEqual(current().acks, [1], 'neither is acknowledged');
    assert.equal(warned, 1, 'one warning for the run of failures');

    await ws.retryUnsaved();
    assert.deepEqual(current().acks, [1], 'still full');
    (db as any).putMessage = put;
    await ws.retryUnsaved();
    assert.deepEqual(current().acks, [1, 2, 3]);
    assert.ok(await db.getMessage(ALICE + '|62000|' + ALICE));
    assert.ok(await db.getMessage(ALICE + '|63000|' + ALICE));
    off();
  });

  it('still acknowledges what can’t be decrypted, or isn’t for the app', async () => {
    decrypted[4] = async () => {
      throw new Error('bad mac');
    };
    decrypted[5] = async () => null;
    current().deliver(4);
    current().deliver(5);
    await settle();
    assert.deepEqual(current().acks.slice(-2), [4, 5]);
  });

  it('never sends a late acknowledgement on a newer connection', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (db as any).putMessage = (rec: any) => gate.then(() => put.call(db, rec));
    decrypted[6] = message(66000);
    const first = current();
    first.deliver(6);
    await settle();
    ws.restart();
    const second = current();
    assert.notEqual(second, first);
    second.open();
    release();
    await settle();
    assert.equal(first.acks.indexOf(6), -1);
    assert.deepEqual(second.acks, []);
    (db as any).putMessage = put;
  });

  it('after a reconnect, notifies once per chat when the offline queue is replayed', async () => {
    current().deliver(QUEUE_EMPTY);
    await settle();
    showNotifications(true);
    notified.length = 0;
    ws.restart();
    current().open();
    decrypted[30] = message(30000);
    decrypted[31] = message(31000, BOB);
    decrypted[32] = message(32000);
    current().deliver(30);
    current().deliver(31);
    current().deliver(32);
    await settle();
    assert.deepEqual(notified, [], 'nothing while the queue is replayed');
    current().deliver(QUEUE_EMPTY);
    await settle();
    assert.deepEqual(notified.slice().sort(), [ALICE, BOB]);
    showNotifications(false);
  });

  it('reconnects when a keepalive goes unanswered', async () => {
    const live = current();
    mock.timers.tick(25000);
    assert.equal(live.keepalives(), 1);
    live.reply();
    mock.timers.tick(25000);
    assert.equal(live.keepalives(), 2);
    assert.equal(live.readyState, 1, 'answered, so still open');

    mock.timers.tick(25000);
    assert.equal(live.readyState, 3, 'unanswered, so dropped');
    assert.equal(store.connectionState(), 'closed');
    ws.connect();
    assert.notEqual(current(), live);
  });

  it('says to check the clock when the connection fails on a certificate date, until it connects', async () => {
    const live = current();
    live.onclose!({ code: 1015, reason: 'secure connection failed: invalid peer certificate: certificate not valid yet: verification time 1 (UNIX)' });
    assert.equal(store.connectionState(), 'closed');
    assert.equal(ws.connectionProblem(), 'clock');
    ws.connect();
    current().open();
    assert.equal(ws.connectionProblem(), null);
    current().onclose!({ code: 1006, reason: 'connection lost' });
    assert.equal(ws.connectionProblem(), null);
    ws.connect();
    current().open();
  });

  it('checks PreKeys when the socket opens, at most every 12 hours', async () => {
    await settle();
    assert.equal(preKeyChecks, 1);
    ws.restart();
    current().open();
    await settle();
    assert.equal(preKeyChecks, 1, 'a reconnect soon after does not check again');
    config.setPreKeysCheckedAt(Date.now() - 13 * 60 * 60 * 1000);
    ws.restart();
    current().open();
    await settle();
    assert.equal(preKeyChecks, 2);
  });

  it('never puts the password in a URL: without the pinned client it doesn’t connect', () => {
    const s = signal as any;
    const urls: string[] = [];
    const g = globalThis as any;
    const realWs = g.WebSocket;
    g.WebSocket = function (url: string) {
      urls.push(url);
      return new FakeSocket();
    };
    s.net.isPinnedUrl = () => false;
    const before = sockets.length;
    try {
      ws.stop();
      ws.connect();
      assert.deepEqual(urls, []);
      assert.equal(sockets.length, before);
    } finally {
      g.WebSocket = realWs;
      s.net.isPinnedUrl = () => true;
      ws.connect();
      current().open();
    }
  });
});
