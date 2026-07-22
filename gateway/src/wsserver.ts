/* App-facing receive WebSocket at /v1/receive/<number>?since=<seq>. On connect it
   replays buffered frames with seq > since as "backlog" envelopes, sends a
   "backlog-done" sentinel carrying the newest seq, then streams live "frame"
   envelopes. Envelope: { t: 'backlog'|'backlog-done'|'frame', seq, data }. */

import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { log, maskNumber } from './log';
import * as buffer from './buffer';
import * as clients from './clients';
import * as upstream from './upstream';

const wss = new WebSocketServer({ noServer: true });

export function isReceivePath(pathname: string): boolean {
  return /^\/v1\/receive\/[^/]+$/.test(pathname);
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
  // The device's push endpoint (optional). Lets push skip only the devices that
  // are actually open, so another device sharing the number still gets notified.
  const endpoint = url.searchParams.get('ep') || null;

  wss.handleUpgrade(req, socket, head, function (ws) {
    onConnect(ws, number, since, endpoint);
  });
}

function onConnect(ws: WebSocket, number: string, since: number, endpoint: string | null): void {
  log.info('app connected ' + maskNumber(number) + ' since=' + since);

  // Make sure we are receiving upstream for this number.
  upstream.ensureNumber(number);

  clients.add(number, ws, endpoint);
  ws.on('close', function () {
    clients.remove(number, ws);
    log.info('app disconnected ' + maskNumber(number));
  });
  ws.on('error', function () {
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
