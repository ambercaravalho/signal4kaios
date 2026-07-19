/* One persistent upstream receive WebSocket per Signal number, pointed at
   signal-cli-rest-api's /v1/receive/<number>. Each frame is assigned a per-number
   seq, buffered, fanned out to connected app clients, and handed to an optional
   frame hook (used for Web Push). Reconnects with capped backoff so the buffer
   keeps filling even while the app is closed. */

import WebSocket from 'ws';
import { config } from './config';
import { log, maskNumber } from './log';
import * as buffer from './buffer';
import * as clients from './clients';

type FrameHook = (number: string, text: string) => void;

let frameHook: FrameHook | null = null;

export function setFrameHook(fn: FrameHook): void {
  frameHook = fn;
}

interface Receiver {
  ws: WebSocket | null;
  backoff: number;
  stopped: boolean;
  timer: NodeJS.Timeout | null;
}

const receivers = new Map<string, Receiver>();

const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 30000;

export function ensureNumber(number: string): void {
  if (!number || receivers.has(number)) return;
  const r: Receiver = { ws: null, backoff: MIN_BACKOFF, stopped: false, timer: null };
  receivers.set(number, r);
  buffer.addNumber(number);
  connect(number, r);
}

function scheduleReconnect(number: string, r: Receiver): void {
  if (r.stopped || r.timer) return;
  const delay = r.backoff;
  r.backoff = Math.min(r.backoff * 2, MAX_BACKOFF);
  r.timer = setTimeout(function () {
    r.timer = null;
    connect(number, r);
  }, delay);
}

function connect(number: string, r: Receiver): void {
  if (r.stopped) return;
  const url = config.signalCliWsUrl + '/v1/receive/' + encodeURIComponent(number);
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    log.error('upstream connect failed ' + maskNumber(number), e);
    scheduleReconnect(number, r);
    return;
  }
  r.ws = ws;

  ws.on('open', function () {
    r.backoff = MIN_BACKOFF;
    log.info('upstream open ' + maskNumber(number));
  });

  ws.on('message', function (data: WebSocket.RawData) {
    const text = data.toString();
    handleFrame(number, text);
  });

  ws.on('close', function () {
    r.ws = null;
    log.warn('upstream closed ' + maskNumber(number) + ', reconnecting');
    scheduleReconnect(number, r);
  });

  ws.on('error', function (err: Error) {
    log.error('upstream error ' + maskNumber(number), err);
    // 'close' fires after 'error'; reconnect is scheduled there.
  });
}

function handleFrame(number: string, text: string): void {
  // Guard the parse: a malformed frame must never crash the receiver.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log.warn('upstream non-JSON frame ' + maskNumber(number) + ', skipped');
    return;
  }
  const seq = buffer.addFrame(number, text);
  clients.fanout(number, { t: 'frame', seq: seq, data: parsed });
  if (frameHook) {
    try {
      frameHook(number, text);
    } catch (e) {
      log.error('frame hook failed ' + maskNumber(number), e);
    }
  }
}

/* Resume receivers for every number we already know about (subscriptions or
   prior app connections) so buffering + push survive a gateway restart. */
export function resumeKnown(): void {
  const nums = buffer.allNumbers();
  nums.forEach(ensureNumber);
  if (nums.length) log.info('resumed ' + nums.length + ' upstream receiver(s)');
}
