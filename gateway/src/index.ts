/* Gateway entrypoint: one HTTP server that owns /healthz, /v1/pair*, and /v1/push/*, relays /v1/receive/<number> WebSockets, and reverse-proxies everything else to signal-cli-rest-api. Everything except /healthz, POST /v1/pair, and CORS preflights requires a paired device token (Authorization: Bearer). On boot it resumes upstream receivers for known numbers, and prints a pairing code if no device is paired yet. */

import * as http from 'http';
import { URL } from 'url';
import { config } from './config';
import { log } from './log';
import * as auth from './auth';
import * as proxy from './proxy';
import * as wsserver from './wsserver';
import * as upstream from './upstream';
import * as push from './push';
import * as signal from './signal';

const MAX_BODY_BYTES = 1024 * 1024; // pairing and push bodies are tiny

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '600'
};

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS));
  res.end(status === 204 ? undefined : JSON.stringify(obj));
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

/* The Signal numbers registered/linked on signal-cli, for the pairing reply. */
function signalAccounts(): Promise<string[]> {
  return signal.listAccounts()
    ['catch'](function (e: unknown) {
      log.error('pair: could not list signal-cli accounts', e);
      return [] as string[];
    });
}

function handlePair(req: http.IncomingMessage, res: http.ServerResponse): void {
  const ip = req.socket.remoteAddress || 'unknown';
  if (!auth.allowPairAttempt(ip)) {
    log.warn('pair: too many attempts, throttled');
    sendJson(res, 429, { error: 'too many attempts, try again later' });
    return;
  }
  readJson(req).then(function (body) {
    const paired = auth.redeem(String((body && body.code) || ''), body && body.name);
    if (!paired) {
      log.warn('pair: rejected an invalid or expired code');
      sendJson(res, 403, { error: 'invalid or expired pairing code' });
      return;
    }
    log.info('pair: paired device ' + paired.id);
    return signalAccounts().then(function (numbers) {
      sendJson(res, 200, { token: paired.token, deviceId: paired.id, numbers: numbers });
    });
  })['catch'](function () {
    sendJson(res, 400, { error: 'invalid body' });
  });
}

/* Routes that require a paired device. deviceId is the authenticated device. */
function handleAuthed(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deviceId: number
): void {
  if (pathname === '/v1/pair/revoke' && req.method === 'POST') {
    auth.revoke(deviceId);
    wsserver.dropDevice(deviceId);
    log.info('pair: device ' + deviceId + ' unpaired itself');
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
      push.register(String(body.number), body.subscription, deviceId);
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

  if (pathname === '/v1/push/test' && req.method === 'POST') {
    readJson(req).then(function (body) {
      const number = body && body.number ? String(body.number) : '';
      if (!number) {
        sendJson(res, 400, { error: 'number required' });
        return;
      }
      const empty = !!(body && body.empty);
      push.sendTest(number, empty).then(function (results) {
        sendJson(res, 200, { sent: results.length, empty: empty, results: results });
      });
    })['catch'](function () {
      sendJson(res, 400, { error: 'invalid body' });
    });
    return;
  }

  // Everything else -> signal-cli-rest-api.
  proxy.handle(req, res);
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, null);
    return;
  }

  if (pathname === '/healthz') {
    sendJson(res, 200, { ok: true, gateway: 'signal4kaios' });
    return;
  }

  if (pathname === '/v1/pair' && req.method === 'POST') {
    handlePair(req, res);
    return;
  }

  const deviceId = auth.verify(auth.bearer(req.headers.authorization));
  if (deviceId == null) {
    sendJson(res, 401, { error: 'unpaired' });
    return;
  }
  handleAuthed(req, res, pathname, deviceId);
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
wsserver.startRevocationSweep();
wsserver.startHeartbeat();

server.listen(config.port, function () {
  log.info('gateway listening on :' + config.port + ' -> ' + config.signalCliUrl);
  if (!auth.hasDevices()) {
    const c = auth.issueCode();
    console.log(auth.pairingBanner(c.code, c.expiresAt));
  } else {
    log.info('pairing: ' + auth.list().length + ' paired device(s); new code: npm run pair');
  }
});
