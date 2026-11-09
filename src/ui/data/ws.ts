/* The connection to Signal (`wss://chat.signal.org/v1/websocket/`). Each `PUT /api/v1/message` envelope is decrypted on the phone and acknowledged only after it is stored. While the phone is offline Signal queues messages and replays them on connect, then sends `PUT /api/v1/queue/empty`. */

import { signal } from './api';
import { config } from './config';
import { dbg } from './log';
import { scheduleAlarm } from './platform';
import { ingestRaw, refreshDirectory, setConnection } from './store';
import type { SocketLike } from '../../engine/net/transport';

const CLOSE_UNAUTHORIZED = 4001;
const CLOSE_FORBIDDEN = 4003;
const SOCK_CONNECTING = 0;
const SOCK_OPEN = 1;
const HEARTBEAT_MS = 30000;
const KEEPALIVE_MS = 25000;
const WAKE_ALARM_MS = 300000;

let sock: SocketLike | null = null;
let attempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let wanted = false;
let everConnected = false;
let lastCloseAt = 0;
let framesThisSession = 0;
let drainingQueue = true;
let unlinkedHandler: (() => void) | null = null;
let lastMessage = 0;

export function onUnlinked(fn: () => void): void {
  unlinkedHandler = fn;
}

/** When the last message arrived over the socket, for Settings > Debug. */
export function lastMessageAt(): number {
  return lastMessage;
}

export function state(): 'open' | 'connecting' | 'closed' {
  if (sock && sock.readyState === SOCK_OPEN) return 'open';
  if (sock && sock.readyState === SOCK_CONNECTING) return 'connecting';
  return 'closed';
}

function sendFrame(bytes: Uint8Array, what: string): void {
  if (!sock || sock.readyState !== SOCK_OPEN) return;
  try {
    sock.send(bytes);
  } catch (e: any) {
    dbg('ws: ' + what + ' failed ' + (e && e.message));
  }
}

function sendAck(reqId: bigint | undefined): void {
  if (reqId === undefined) return;
  sendFrame(signal.encodeWsAck(reqId, 200, 'OK'), 'ack');
}

function scheduleWakeAlarm(): void {
  scheduleAlarm(new Date(Date.now() + WAKE_ALARM_MS), { type: 's4k-wake' }).catch((e) => dbg('ws: could not schedule wake alarm ' + (e && e.message)));
}

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (wanted && state() === 'closed' && !reconnectTimer) {
      dbg('ws: heartbeat found a dead socket, reconnecting');
      attempts = 0;
      connect();
    }
  }, HEARTBEAT_MS);
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  attempts += 1;
  const base = Math.min(60000, 1000 * Math.pow(2, Math.min(attempts, 6)));
  const delay = base / 2 + Math.floor(Math.random() * (base / 2));
  dbg('ws: reconnect in ' + delay + 'ms (attempt ' + attempts + ')');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function onMessage(data: unknown): void {
  if (typeof data === 'string') return;
  let wsMsg: any;
  try {
    wsMsg = signal.decodeWsFrame(data as ArrayBuffer);
  } catch (e: any) {
    dbg('ws: undecodable frame ' + (e && e.message));
    return;
  }
  if (!wsMsg || wsMsg.type !== 1 || !wsMsg.request) return;
  const req = wsMsg.request;
  if (req.path === '/api/v1/queue/empty') {
    drainingQueue = false;
    sendAck(req.id);
    dbg('ws: offline queue drained');
    return;
  }
  if (req.path === '/api/v1/message' && req.body && req.body.length) {
    const silent = drainingQueue;
    framesThisSession += 1;
    lastMessage = Date.now();
    signal
      .processIncomingEnvelope(req.body)
      .then((frame) => {
        if (frame) ingestRaw(frame, { silent });
        sendAck(req.id);
      })
      .catch((err: any) => {
        dbg('ws: envelope decrypt error: ' + (err && err.message));
        // An undecryptable envelope is acknowledged so it can't block the queue forever.
        sendAck(req.id);
      });
    return;
  }
  sendAck(req.id);
}

export function connect(): void {
  wanted = true;
  startHeartbeat();
  if (!config.isConfigured()) return;
  if (sock && (sock.readyState === SOCK_OPEN || sock.readyState === SOCK_CONNECTING)) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const baseUrl = config.wsUrl() + '/v1/websocket/?agent=OWD';
  dbg('ws: connecting');
  setConnection('connecting');
  drainingQueue = true;

  try {
    // SECURITY-REVIEW: device credentials go only to Signal's WebSocket endpoint and are never logged. Signal authenticates the upgrade by its Authorization header and treats query-string credentials as an anonymous socket, so only the pinned client (which can set headers) receives messages.
    const auth = 'Basic ' + btoa(config.login() + ':' + config.deviceToken());
    if (signal.net.isPinnedUrl(baseUrl)) {
      sock = signal.net.openWebSocket(baseUrl, { headers: { Authorization: auth, 'X-Signal-Receive-Stories': 'false' } });
    } else {
      const ws = new WebSocket(baseUrl + '&login=' + encodeURIComponent(config.login()) + '&password=' + encodeURIComponent(config.deviceToken()));
      ws.binaryType = 'arraybuffer';
      sock = ws as unknown as SocketLike;
    }
  } catch (e: any) {
    dbg('ws: could not open ' + (e && e.message));
    scheduleReconnect();
    return;
  }

  const s = sock;
  s.onopen = () => {
    attempts = 0;
    framesThisSession = 0;
    if (everConnected && lastCloseAt) {
      dbg('ws: reconnected after ' + (Date.now() - lastCloseAt) + 'ms');
      refreshDirectory().catch((e) => dbg('ws: resync failed ' + (e && e.message)));
    } else {
      dbg('ws: open');
    }
    everConnected = true;
    scheduleWakeAlarm();
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => sendFrame(signal.encodeWsKeepalive(), 'keepalive'), KEEPALIVE_MS);
    setConnection('open');
  };
  s.onmessage = (evt) => onMessage(evt.data);
  s.onclose = (evt) => {
    lastCloseAt = Date.now();
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    dbg('ws: closed (code ' + evt.code + ', ' + framesThisSession + ' frames)');
    setConnection('closed');
    if (sock === s) sock = null;
    if (evt.code === CLOSE_UNAUTHORIZED || evt.code === CLOSE_FORBIDDEN) {
      dbg('ws: Signal rejected this device (unlinked)');
      wanted = false;
      if (unlinkedHandler) unlinkedHandler();
      return;
    }
    if (wanted) scheduleReconnect();
  };
  s.onerror = () => dbg('ws: error');
}

export function stop(): void {
  wanted = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  if (sock) {
    sock.onclose = null;
    try {
      sock.close();
    } catch {
      // already closed
    }
    sock = null;
  }
  setConnection('closed');
}

/** Drop the connection and any idle TLS connections, then connect again. */
export function restart(): void {
  stop();
  signal.net.reset();
  attempts = 0;
  connect();
}

function wakeIfClosed(): void {
  if (wanted && state() === 'closed') {
    attempts = 0;
    connect();
  }
}

/** Reconnect when the app returns to the foreground or the ServiceWorker relays a wake alarm. */
export function installWakeHandlers(): void {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) wakeIfClosed();
  });
  if (navigator.serviceWorker && navigator.serviceWorker.addEventListener) {
    navigator.serviceWorker.addEventListener('message', (evt) => {
      const data = evt && evt.data;
      if (data && data.type === 's4k-wake') {
        dbg('ws: wake alarm');
        wakeIfClosed();
        scheduleWakeAlarm();
      }
    });
  }
}
