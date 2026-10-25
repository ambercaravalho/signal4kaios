/* App-facing receive WebSocket at /v1/receive/<number>?since=<seq>. On connect it replays buffered frames with seq > since as "backlog" envelopes, sends a "backlog-done" sentinel carrying the newest seq, then streams live "frame" envelopes. Envelope: { t: 'backlog'|'backlog-done'|'frame', seq, data }.

   Auth: browsers can't set headers on a WebSocket, so the app offers the subprotocols ['s4k.v1', 's4k.auth.<token>']. We answer with 's4k.v1' (never echoing the token) and, if the token isn't a paired device, close with 4401 so the app can tell "unpaired" from "offline". */

import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { log, maskNumber } from './log';
import * as auth from './auth';
import * as buffer from './buffer';
import * as clients from './clients';
import * as upstream from './upstream';

export const PROTOCOL = 's4k.v1';
const AUTH_PREFIX = 's4k.auth.';
export const CLOSE_UNPAIRED = 4401;
const REVOCATION_SWEEP_MS = 60 * 1000;

const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: function (protocols: Set<string>) {
    return protocols.has(PROTOCOL) ? PROTOCOL : false;
  }
});

// Device id for every authenticated socket, so a revoke can drop it.
const socketDevice = new Map<WebSocket, number>();

export function isReceivePath(pathname: string): boolean {
  return /^\/v1\/receive\/[^/]+$/.test(pathname);
}

function tokenFromProtocols(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header.split(',');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p.indexOf(AUTH_PREFIX) === 0) return p.slice(AUTH_PREFIX.length);
  }
  return null;
}

export function handleUpgrade(
  req: http.IncomingMessage,
  socket: import('stream').Duplex,
  head: Buffer
): void {
  const url = new URL(req.url || '', 'http://localhost');
  const match = url.pathname.match(/^\/v1\/receive\/([^/]+)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const number = decodeURIComponent(match[1]);
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw ? parseInt(sinceRaw, 10) || 0 : 0;
  // The device's push endpoint (optional). Lets push skip only the devices that are actually open, so another device sharing the number still gets notified.
  const endpoint = url.searchParams.get('ep') || null;
  const deviceId = auth.verify(tokenFromProtocols(req.headers['sec-websocket-protocol']));

  wss.handleUpgrade(req, socket, head, function (ws) {
    if (deviceId == null) {
      log.warn('ws: rejected unpaired client');
      ws.close(CLOSE_UNPAIRED, 'unpaired');
      return;
    }
    onConnect(ws, number, since, endpoint, deviceId);
  });
}

function onConnect(
  ws: WebSocket,
  number: string,
  since: number,
  endpoint: string | null,
  deviceId: number
): void {
  log.info('app connected ' + maskNumber(number) + ' device=' + deviceId + ' since=' + since);

  // Make sure we are receiving upstream for this number.
  upstream.ensureNumber(number);

  socketDevice.set(ws, deviceId);
  clients.add(number, ws, endpoint);
  ws.on('close', function () {
    socketDevice.delete(ws);
    clients.remove(number, ws);
    log.info('app disconnected ' + maskNumber(number));
  });
  ws.on('error', function () {
    socketDevice.delete(ws);
    clients.remove(number, ws);
  });

  // Replay backlog, then a sentinel. Live frames arrive via clients.fanout.
  try {
    const rows = buffer.framesSince(number, since);
    rows.forEach(function (row) {
      ws.send(JSON.stringify({ t: 'backlog', seq: row.seq, data: JSON.parse(row.json) }));
    });
    ws.send(JSON.stringify({ t: 'backlog-done', seq: buffer.maxSeq(number) }));
  } catch (e) {
    log.error('backlog replay failed ' + maskNumber(number), e);
  }
}

/* Close every socket belonging to a device (after it is revoked). */
export function dropDevice(deviceId: number): void {
  socketDevice.forEach(function (id, ws) {
    if (id === deviceId) ws.close(CLOSE_UNPAIRED, 'unpaired');
  });
}

/* Revokes from the CLI happen in another process; periodically drop sockets whose device no longer exists. */
export function startRevocationSweep(): void {
  setInterval(function () {
    const seen = new Set<number>();
    socketDevice.forEach(function (id) { seen.add(id); });
    seen.forEach(function (id) {
      if (!auth.exists(id)) dropDevice(id);
    });
  }, REVOCATION_SWEEP_MS).unref();
}
