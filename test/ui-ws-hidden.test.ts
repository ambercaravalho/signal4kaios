import './ui-env';
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { signal } from '../src/ui/data/api';
import { config } from '../src/ui/data/config';
import { db } from '../src/ui/data/db';
import { bringToFront, wakeAlarmData } from '../src/ui/data/wake';
import * as ws from '../src/ui/data/ws';
import { S } from '../src/ui/strings';
import { settle } from './helpers';

const ALICE = '+15550001';
const QUEUE_EMPTY = 255;

class FakeSocket {
  readyState = 0;
  binaryType = '';
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason?: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  keepalives = 0;
  send(bytes: Uint8Array): void {
    if (bytes[0] === 0) this.keepalives++;
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    if (this.onopen) this.onopen({});
  }
  deliver(id: number): void {
    this.onmessage!({ data: new Uint8Array([id]).buffer });
  }
}

const sockets: FakeSocket[] = [];
const current = () => sockets[sockets.length - 1];
const notified: string[] = [];
const alarms: Array<{ id: number; date: Date; data: any }> = [];
let nextAlarm = 1;

before(async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  Object.defineProperty(globalThis.navigator, 'b2g', {
    configurable: true,
    value: {
      alarmManager: {
        add: async (a: { date: Date; data: any }) => {
          alarms.push({ id: nextAlarm, ...a });
          return nextAlarm++;
        },
        getAll: async () => alarms.slice(),
        remove: (id: number) => {
          const i = alarms.findIndex((a) => a.id === id);
          if (i >= 0) alarms.splice(i, 1);
        },
      },
    },
  });
  (globalThis as any).document.hidden = true;
  (globalThis as any).window = { addEventListener() {} };
  (globalThis as any).Notification = class {
    onclick: unknown = null;
    constructor(_title: string, opts: { tag: string }) {
      notified.push(opts.tag);
    }
    close(): void {}
  };
  config.set({ number: '+15550000', aci: 'aci-me', deviceId: 2, deviceToken: 'test-only' });
  await db.ready();
  const s = signal as any;
  s.decodeWsFrame = (buf: ArrayBuffer) => {
    const id = new Uint8Array(buf)[0];
    if (id === QUEUE_EMPTY) return { type: 1, request: { path: '/api/v1/queue/empty', id: BigInt(id) } };
    return { type: 1, request: { path: '/api/v1/message', body: new Uint8Array([id]), id: BigInt(id) } };
  };
  s.encodeWsAck = (id: bigint) => new Uint8Array([Number(id)]);
  s.encodeWsKeepalive = () => new Uint8Array([0]);
  s.maintainPreKeys = async () => {};
  s.replayStorageWrites = async () => {};
  s.syncStorage = async () => true;
  s.processIncomingEnvelope = async (body: Uint8Array) => ({ envelope: { sourceNumber: ALICE, timestamp: body[0] * 1000, dataMessage: { timestamp: body[0] * 1000, message: 'm' } } });
  s.net.isPinnedUrl = () => true;
  s.net.openWebSocket = () => {
    const sock = new FakeSocket();
    sockets.push(sock);
    return sock;
  };
});

after(() => {
  ws.stop();
  mock.timers.reset();
  delete (globalThis as any).Notification;
  (globalThis as any).document.hidden = false;
  delete (globalThis as any).window;
  delete (globalThis.navigator as any).b2g;
});

describe('a launch in the background', () => {
  it('quiets only the first queue after the user opened Beacon', () => {
    assert.equal(ws.drainIsQuiet(true, false), true);
    assert.equal(ws.drainIsQuiet(true, true), false);
    assert.equal(ws.drainIsQuiet(false, false), false);
  });

  it('arms the wake alarm before the first connection, carrying the closed notice’s wording', async () => {
    ws.setLaunchedHidden(true);
    ws.connect();
    ws.installWakeHandlers();
    await settle();
    assert.equal(alarms.length, 1);
    assert.deepEqual(alarms[0].data, wakeAlarmData());
    assert.equal(alarms[0].data.notice.title, S.stoppedTitle);
    const due = alarms[0].date.getTime() - Date.now();
    assert.ok(due > 59000 && due <= 60000, 'a minute on while hidden, to wake the phone for the keepalive');
  });

  it('notifies for messages that queued while Beacon was closed', async () => {
    current().open();
    current().deliver(40);
    current().deliver(41);
    await settle();
    assert.deepEqual(notified, [], 'held until the queue is replayed');
    current().deliver(QUEUE_EMPTY);
    await settle();
    assert.deepEqual(notified, [ALICE], 'one per chat');
  });

  it('brings the alarm forward after a warned End, replacing the pending one', async () => {
    ws.wakeSoon(20000);
    await settle();
    assert.equal(alarms.length, 1);
    const due = alarms[0].date.getTime() - Date.now();
    assert.ok(due > 19000 && due <= 20000);
    assert.equal(alarms[0].data.type, 's4k-wake');
  });

  it('asks the ServiceWorker to bring Beacon forward with an alarm due at once', async () => {
    bringToFront();
    await settle();
    const focus = alarms.filter((a) => a.data.type === 's4k-focus');
    assert.equal(focus.length, 1);
    assert.ok(focus[0].date.getTime() - Date.now() < 1000);
    assert.equal(alarms.filter((a) => a.data.type === 's4k-wake').length, 1, 'the wake alarm stays');
  });

  it('stands in for suspended timers: each tick sends a due keepalive, and reconnects a dropped socket', async () => {
    const live = current();
    const t = Date.now();
    ws.pump(t + 1000);
    assert.equal(live.keepalives, 0, 'not due yet');
    ws.pump(t + 25000);
    assert.equal(live.keepalives, 1);
    ws.pump(t + 26000);
    assert.equal(live.keepalives, 1, 'once per keepalive period');
    ws.pump(t + 50000);
    assert.equal(live.readyState, 3, 'the server never answered, so the socket is dropped');
    ws.pump(t + 200000);
    assert.notEqual(current(), live, 'and a later tick reconnects without waiting for the suspended timer');
  });
});
