/* The connection to Signal (`wss://chat.signal.org/v1/websocket/`). Each `PUT /api/v1/message` envelope is decrypted on the phone and acknowledged only after it is stored; one the database refuses is kept in memory and retried, since the server can't decrypt it for us again. While the phone is offline Signal queues messages and replays them on connect, then sends `PUT /api/v1/queue/empty`. */

import { signal } from './api';
import { config } from './config';
import { dbg } from './log';
import { scheduleAlarm } from './platform';
import { ingestRaw, refreshDirectory, setConnection } from './store';
import { emit } from './store/events';
import { SaveError } from './store/ingest';
import type { SocketLike } from '../../engine/net/transport';
import { WAKE_ALARM } from './wake';

const CLOSE_UNAUTHORIZED = 4001;
const CLOSE_FORBIDDEN = 4003;
const SOCK_CONNECTING = 0;
const SOCK_OPEN = 1;
const HEARTBEAT_MS = 30000;
const KEEPALIVE_MS = 25000;
const WAKE_ALARM_MS = 300000;
const SAVE_RETRY_MIN_MS = 5000;
const SAVE_RETRY_MAX_MS = 60000;
/** Caps the decrypted frames kept in memory while storage is full; past it a frame is left unacknowledged, and the server's redelivery is dropped as a duplicate. */
const MAX_UNSAVED = 500;

type Unsaved = { frame: unknown; reqId: bigint | undefined; sock: SocketLike };
const unsaved: Unsaved[] = [];
let saveRetryTimer: ReturnType<typeof setTimeout> | null = null;
let saveRetryMs = SAVE_RETRY_MIN_MS;
let saveFailing = false;

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

function state(): 'open' | 'connecting' | 'closed' {
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

/** Request ids are per connection: after a reconnect the server sends unacknowledged messages again, so a late ack must not reach the new socket. */
function ackOn(s: SocketLike, reqId: bigint | undefined): void {
  if (s === sock) sendAck(reqId);
}

function saveFrame(item: Unsaved, silent: boolean): Promise<boolean> {
  return ingestRaw(item.frame, { silent }).then(
    () => {
      ackOn(item.sock, item.reqId);
      return true;
    },
    (err: any) => {
      if (err instanceof SaveError) return false;
      dbg('ws: message not applied ' + (err && err.message));
      ackOn(item.sock, item.reqId);
      return true;
    }
  );
}

function holdUnsaved(item: Unsaved): void {
  if (unsaved.length >= MAX_UNSAVED) {
    dbg('ws: too many unsaved messages, leaving one unacknowledged');
    return;
  }
  unsaved.push(item);
  if (!saveFailing) {
    saveFailing = true;
    dbg('ws: could not save a message, holding it for a retry');
    emit('save-error');
  }
  if (!saveRetryTimer) {
    saveRetryTimer = setTimeout(() => {
      saveRetryTimer = null;
      retryUnsaved();
    }, saveRetryMs);
    saveRetryMs = Math.min(SAVE_RETRY_MAX_MS, saveRetryMs * 2);
  }
}

/** Store the held messages again, oldest first, and acknowledge the ones that save. */
export function retryUnsaved(): Promise<void> {
  if (saveRetryTimer) {
    clearTimeout(saveRetryTimer);
    saveRetryTimer = null;
  }
  const batch = unsaved.splice(0);
  return batch
    .reduce<Promise<void>>((p, item) => p.then(() => saveFrame(item, true).then((ok) => (ok ? undefined : holdUnsaved(item)))), Promise.resolve())
    .then(() => {
      if (unsaved.length) return;
      saveFailing = false;
      saveRetryMs = SAVE_RETRY_MIN_MS;
    });
}

function scheduleWakeAlarm(): void {
  scheduleAlarm(new Date(Date.now() + WAKE_ALARM_MS), { type: WAKE_ALARM }).catch((e) => dbg('ws: could not schedule wake alarm ' + (e && e.message)));
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

function onMessage(from: SocketLike, data: unknown): void {
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
    signal.processIncomingEnvelope(req.body).then(
      (frame) => {
        if (!frame) return ackOn(from, req.id);
        const item = { frame, reqId: req.id, sock: from };
        saveFrame(item, silent).then((ok) => {
          if (!ok) holdUnsaved(item);
        });
      },
      (err: any) => {
        dbg('ws: envelope decrypt error: ' + (err && err.message));
        // An undecryptable envelope is acknowledged so it can't block the queue forever.
        ackOn(from, req.id);
      }
    );
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
    } else if (signal.net.proxy()) {
      dbg('ws: a proxy is set but the pinned client is unavailable, not connecting directly');
      setConnection('closed');
      return;
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
  s.onmessage = (evt) => onMessage(s, evt.data);
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
      if (data && data.type === WAKE_ALARM) {
        dbg('ws: wake alarm');
        wakeIfClosed();
        scheduleWakeAlarm();
      }
    });
  }
}
