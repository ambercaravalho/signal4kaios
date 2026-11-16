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

class FakeSocket {
  readyState = 0;
  binaryType = '';
  acks: number[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
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
}

const sockets: FakeSocket[] = [];
const current = () => sockets[sockets.length - 1];
const decrypted: Record<number, () => Promise<unknown>> = {};
const message = (ts: number) => async () => ({ envelope: { sourceNumber: ALICE, timestamp: ts, dataMessage: { timestamp: ts, message: 'm' + ts } } });

describe('acknowledging messages', () => {
  const put = db.putMessage;

  before(async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    config.set({ number: '+15550000', aci: 'aci-me', deviceId: 2, deviceToken: 'test-only' });
    await db.ready();
    const s = signal as any;
    s.decodeWsFrame = (buf: ArrayBuffer) => {
      const id = new Uint8Array(buf)[0];
      return { type: 1, request: { path: '/api/v1/message', body: new Uint8Array([id]), id: BigInt(id) } };
    };
    s.encodeWsAck = (id: bigint) => new Uint8Array([Number(id)]);
    s.encodeWsKeepalive = () => new Uint8Array([0]);
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
    ws.stop();
    mock.timers.reset();
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
});
