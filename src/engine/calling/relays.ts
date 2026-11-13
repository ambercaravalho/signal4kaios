/* Signal's TURN relays for 1:1 calls (`GET /v2/calling/relays`, as Signal-Desktop's getIceServers). */

import { asObject, type SignalHttpJsonFn } from '../net/http';
import type { ByteStream } from '../net/transport/stream';
import { TurnClient, TurnError } from './turn';

export interface RelayServer {
  /** SECURITY-REVIEW: short-lived TURN credentials; never log them. */
  username: string;
  password: string;
  urls: string[];
  urlsWithIps: string[];
  /** The name to verify TLS against when connecting to an address in `urlsWithIps`. */
  hostname?: string;
}

export interface RelayEndpoint {
  host: string;
  port: number;
  secure: boolean;
  /** The TLS name when `host` is an IP address. */
  serverName?: string;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length < 512) : []);

export function parseRelays(body: unknown): RelayServer[] {
  const obj = asObject(body);
  const list = obj && Array.isArray(obj.relays) ? obj.relays : [];
  const out: RelayServer[] = [];
  for (const item of list) {
    const r = asObject(item);
    if (!r || typeof r.username !== 'string' || typeof r.password !== 'string') continue;
    const urls = strings(r.urls);
    const urlsWithIps = strings(r.urlsWithIps);
    if (!urls.length && !urlsWithIps.length) continue;
    out.push({ username: r.username, password: r.password, urls, urlsWithIps, hostname: typeof r.hostname === 'string' && r.hostname ? r.hostname : undefined });
  }
  return out;
}

/** A `turn:` or `turns:` URL as a host, port, and transport. Null for UDP-only URLs, which KaiOS can't use, and for anything malformed. */
export function parseTurnUrl(url: string, allowUdp = false): (RelayEndpoint & { udp: boolean }) | null {
  const m = /^(turns?):(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/.exec(url.trim());
  if (!m) return null;
  const secure = m[1] === 'turns';
  const transport = m[4] || (secure ? 'tcp' : 'udp');
  const udp = transport === 'udp';
  if (udp && (secure || !allowUdp)) return null;
  const host = m[2].replace(/^\[|\]$/g, '');
  const port = m[3] ? Number(m[3]) : secure ? 5349 : 3478;
  if (!port || port > 65535) return null;
  return { host, port, secure, udp };
}

/** The stream endpoints to try in order: plain TCP to the relay's addresses (cheapest), then TLS by hostname, since the relay's certificate doesn't cover its IPs. */
export function relayEndpoints(server: RelayServer): RelayEndpoint[] {
  const out: RelayEndpoint[] = [];
  const seen = new Set<string>();
  const add = (e: RelayEndpoint) => {
    const key = `${e.secure}|${e.host}|${e.port}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };
  for (const url of server.urlsWithIps) {
    const e = parseTurnUrl(url);
    if (e && !e.secure && !e.host.includes(':')) add({ host: e.host, port: e.port, secure: false });
  }
  for (const url of [...server.urlsWithIps, ...server.urls]) {
    const e = parseTurnUrl(url);
    if (!e || !e.secure) continue;
    const isIp = /^[0-9.]+$/.test(e.host) || e.host.includes(':');
    const host = isIp ? server.hostname : e.host;
    if (host) add({ host, port: e.port, secure: true });
  }
  for (const url of server.urls) {
    const e = parseTurnUrl(url);
    if (e && !e.secure) add({ host: e.host, port: e.port, secure: false });
  }
  return out;
}

/** Opens a TURN allocation on the first endpoint that works. */
export async function openRelay(server: RelayServer, connect: (host: string, port: number, timeoutMs: number, secure: boolean) => Promise<ByteStream>): Promise<TurnClient> {
  let last: Error = new TurnError('no usable relay address');
  for (const e of relayEndpoints(server)) {
    let turn: TurnClient | null = null;
    try {
      const stream = await connect(e.host, e.port, 5000, e.secure);
      turn = new TurnClient(stream, { username: server.username, password: server.password });
      await turn.allocate();
      return turn;
    } catch (err) {
      if (turn) turn.close();
      last = err instanceof Error ? err : new TurnError(String(err));
    }
  }
  throw last;
}

export async function fetchRelays(httpJson: SignalHttpJsonFn, auth: { username: string; password: string }): Promise<RelayServer[]> {
  const res = await httpJson('GET', '/v2/calling/relays', null, { basicAuth: auth, timeout: 10000 });
  return parseRelays(res);
}
