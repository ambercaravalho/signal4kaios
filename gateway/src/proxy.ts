/* Generic reverse proxy: every HTTP request the gateway doesn't own is streamed
   verbatim (method, path, query, headers, body, binary) to signal-cli-rest-api
   and its response streamed back. signal-cli has no /v1/push/* routes, so there
   is no collision with the gateway-owned endpoints. */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { config } from './config';
import { log } from './log';

const upstreamIsHttps = config.signalCliUrl.startsWith('https:');
const agentMod = upstreamIsHttps ? https : http;

export function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const target = new URL(config.signalCliUrl + (req.url || '/'));

  const headers = Object.assign({}, req.headers);
  headers.host = target.host;

  const options: http.RequestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (upstreamIsHttps ? 443 : 80),
    method: req.method,
    path: target.pathname + target.search,
    headers: headers
  };

  const upstream = agentMod.request(options, function (up) {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });

  upstream.on('error', function (err) {
    log.error('proxy upstream error ' + (req.method || '') + ' ' + (req.url || ''), err);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'gateway upstream unavailable' }));
  });

  req.pipe(upstream);
}
