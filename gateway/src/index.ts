/* Gateway entrypoint: one HTTP server that owns /healthz and /v1/push/*, relays
   /v1/receive/<number> WebSockets, and reverse-proxies everything else to
   signal-cli-rest-api. On boot it resumes upstream receivers for known numbers. */

import * as http from 'http';
import { URL } from 'url';
import { config } from './config';
import { log } from './log';
import * as proxy from './proxy';
import * as wsserver from './wsserver';
import * as upstream from './upstream';
import * as push from './push';

const MAX_BODY_BYTES = 1024 * 1024; // push registrations are tiny

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', function (c: Buffer) {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'OPTIONS' && pathname.indexOf('/v1/push/') === 0) {
    sendJson(res, 204, {});
    return;
  }

  if (pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/v1/push/vapid' && req.method === 'GET') {
    sendJson(res, 200, { publicKey: push.vapidPublicKey() });
    return;
  }

  if (pathname === '/v1/push/register' && req.method === 'POST') {
    readJson(req).then(function (body) {
      if (!body || !body.number || !body.subscription) {
        sendJson(res, 400, { error: 'number and subscription required' });
        return;
      }
      push.register(String(body.number), body.subscription);
      sendJson(res, 200, { ok: true });
    })['catch'](function () {
      sendJson(res, 400, { error: 'invalid body' });
    });
    return;
  }

  if (pathname === '/v1/push/unregister' && req.method === 'POST') {
    readJson(req).then(function (body) {
      if (!body || !body.endpoint) {
        sendJson(res, 400, { error: 'endpoint required' });
        return;
      }
      push.unregister(String(body.endpoint));
      sendJson(res, 200, { ok: true });
    })['catch'](function () {
      sendJson(res, 400, { error: 'invalid body' });
    });
    return;
  }

  if (pathname === '/v1/push/pending' && req.method === 'GET') {
    const number = url.searchParams.get('number');
    if (!number) {
      sendJson(res, 400, { error: 'number required' });
      return;
    }
    sendJson(res, 200, { messages: push.pending(number) });
    return;
  }

  // Everything else -> signal-cli-rest-api.
  proxy.handle(req, res);
});

server.on('upgrade', function (req, socket, head) {
  const url = new URL(req.url || '/', 'http://localhost');
  if (wsserver.isReceivePath(url.pathname)) {
    wsserver.handleUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

// Wire push into the upstream frame path, then start.
upstream.setFrameHook(push.onIncoming);
push.init();
upstream.resumeKnown();

server.listen(config.port, function () {
  log.info('gateway listening on :' + config.port + ' -> ' + config.signalCliUrl);
});
