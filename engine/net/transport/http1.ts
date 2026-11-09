/** Minimal HTTP/1.1 client over a `ByteStream`, with a small keep-alive pool per host. Responses are untrusted input: sizes are capped and malformed framing fails the request. */

import { ByteStream, concatBytes, Connector, TransportError, writeAll } from './stream';

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | null;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  /** Lower-cased names; repeated headers are joined with ", ". */
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface ResponseHead {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Bytes consumed by the status line, headers, and the blank line. */
  length: number;
}

const MAX_HEAD_BYTES = 64 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 200 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const encoder = new TextEncoder();
const latin1 = new TextDecoder('latin1');

function protocolError(message: string): TransportError {
  return new TransportError('protocol', message);
}

function indexOfCrlfCrlf(buf: Uint8Array, from = 0): number {
  for (let i = Math.max(0, from); i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

function indexOfCrlf(buf: Uint8Array, from = 0): number {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  }
  return -1;
}

/** Parses a status line and headers once the blank line has arrived; returns null while incomplete. */
export function parseResponseHead(buf: Uint8Array): ResponseHead | null {
  const end = indexOfCrlfCrlf(buf);
  if (end < 0) {
    if (buf.length > MAX_HEAD_BYTES) throw protocolError('response headers are too large');
    return null;
  }
  const lines = latin1.decode(buf.subarray(0, end)).split('\r\n');
  const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0]);
  if (!m) throw protocolError('malformed HTTP status line');
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon <= 0) throw protocolError('malformed HTTP header');
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!TOKEN.test(name)) throw protocolError('malformed HTTP header name');
    const value = line.slice(colon + 1).trim();
    headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
  }
  return { status: Number(m[1]), statusText: m[2] || '', headers, length: end + 4 };
}

type BodyMode = { kind: 'none' } | { kind: 'length'; remaining: number } | { kind: 'chunked' } | { kind: 'close' };

/** Incremental response reader. `feed` returns true once the response is complete. */
export class ResponseParser {
  head: ResponseHead | null = null;
  /** False when the connection can't carry another request (`Connection: close` or a read-until-close body). */
  reusable = true;
  private buf: Uint8Array = new Uint8Array(0);
  private mode: BodyMode | null = null;
  private parts: Uint8Array[] = [];
  private size = 0;
  private chunkRemaining = -1;
  private inTrailers = false;
  private done = false;

  constructor(private readonly method: string, private readonly maxBytes: number) {}

  get complete(): boolean {
    return this.done;
  }

  /** Any bytes the server sent beyond this response. */
  get leftover(): Uint8Array {
    return this.buf;
  }

  feed(data: Uint8Array): boolean {
    if (this.done) {
      this.buf = concatBytes(this.buf, data);
      return true;
    }
    this.buf = concatBytes(this.buf, data);
    if (!this.head) {
      for (;;) {
        const head = parseResponseHead(this.buf);
        if (!head) return false;
        this.buf = this.buf.subarray(head.length);
        if (head.status >= 100 && head.status < 200 && head.status !== 101) continue;
        this.head = head;
        break;
      }
      this.mode = this.bodyMode(this.head);
      if ((this.head.headers['connection'] || '').toLowerCase().includes('close')) this.reusable = false;
    }
    return this.consumeBody();
  }

  /** Call when the stream ends; returns true if that legitimately completes the response. */
  end(): boolean {
    if (this.done) return true;
    if (this.head && this.mode && this.mode.kind === 'close') {
      this.done = true;
      return true;
    }
    return false;
  }

  body(): Uint8Array {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const p of this.parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  private bodyMode(head: ResponseHead): BodyMode {
    if (this.method === 'HEAD' || head.status === 204 || head.status === 304 || head.status === 101) return { kind: 'none' };
    const te = (head.headers['transfer-encoding'] || '').toLowerCase();
    if (te) {
      if (te.split(',').map((s) => s.trim()).pop() !== 'chunked') throw protocolError(`unsupported transfer encoding ${te}`);
      return { kind: 'chunked' };
    }
    const cl = head.headers['content-length'];
    if (cl !== undefined) {
      if (!/^\d+$/.test(cl)) throw protocolError('malformed Content-Length');
      const n = Number(cl);
      if (n > this.maxBytes) throw protocolError('response is too large');
      return { kind: 'length', remaining: n };
    }
    this.reusable = false;
    return { kind: 'close' };
  }

  private take(n: number): void {
    const part = this.buf.subarray(0, n);
    this.size += part.length;
    if (this.size > this.maxBytes) throw protocolError('response is too large');
    this.parts.push(part.slice());
    this.buf = this.buf.subarray(n);
  }

  private consumeBody(): boolean {
    const mode = this.mode as BodyMode;
    switch (mode.kind) {
      case 'none':
        this.done = true;
        return true;
      case 'close':
        this.take(this.buf.length);
        return false;
      case 'length': {
        const n = Math.min(mode.remaining, this.buf.length);
        this.take(n);
        mode.remaining -= n;
        if (mode.remaining === 0) this.done = true;
        return this.done;
      }
      case 'chunked':
        return this.consumeChunks();
    }
  }

  private consumeChunks(): boolean {
    for (;;) {
      if (this.inTrailers) {
        const eol = indexOfCrlf(this.buf);
        if (eol < 0) return this.guardLine();
        this.buf = this.buf.subarray(eol + 2);
        if (eol === 0) {
          this.done = true;
          return true;
        }
        continue;
      }
      if (this.chunkRemaining < 0) {
        const eol = indexOfCrlf(this.buf);
        if (eol < 0) return this.guardLine();
        const sizeText = latin1.decode(this.buf.subarray(0, eol)).split(';')[0].trim();
        if (!/^[0-9a-fA-F]{1,8}$/.test(sizeText)) throw protocolError('malformed chunk size');
        this.buf = this.buf.subarray(eol + 2);
        const size = parseInt(sizeText, 16);
        if (size === 0) {
          this.inTrailers = true;
          continue;
        }
        this.chunkRemaining = size;
      }
      if (this.chunkRemaining > 0) {
        const n = Math.min(this.chunkRemaining, this.buf.length);
        this.take(n);
        this.chunkRemaining -= n;
        if (this.chunkRemaining > 0) return false;
      }
      if (this.buf.length < 2) return false;
      if (this.buf[0] !== 13 || this.buf[1] !== 10) throw protocolError('malformed chunk terminator');
      this.buf = this.buf.subarray(2);
      this.chunkRemaining = -1;
    }
  }

  private guardLine(): boolean {
    if (this.buf.length > 4096) throw protocolError('chunk header line is too long');
    return false;
  }
}

export function assertSafeHeader(name: string, value: string): void {
  if (!TOKEN.test(name)) throw new TransportError('protocol', `invalid header name ${JSON.stringify(name)}`);
  if (/[\r\n\0]/.test(value)) throw new TransportError('protocol', `invalid value for header ${name}`);
}

export function parseHttpsUrl(url: string, schemes: string[]): { host: string; port: number; target: string; scheme: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new TransportError('protocol', 'invalid URL');
  }
  const scheme = u.protocol.replace(/:$/, '');
  if (!schemes.includes(scheme)) throw new TransportError('protocol', `unsupported URL scheme ${scheme}`);
  if (u.username || u.password) throw new TransportError('protocol', 'URLs with credentials are not supported');
  const port = u.port ? Number(u.port) : 443;
  return { host: u.hostname.toLowerCase(), port, target: (u.pathname || '/') + u.search, scheme };
}

export function buildRequestHead(method: string, target: string, host: string, port: number, headers: Record<string, string>): Uint8Array {
  if (!TOKEN.test(method)) throw new TransportError('protocol', 'invalid HTTP method');
  if (/[\s]/.test(target)) throw new TransportError('protocol', 'invalid request target');
  let head = `${method} ${target} HTTP/1.1\r\nHost: ${port === 443 ? host : `${host}:${port}`}\r\n`;
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'host') continue;
    assertSafeHeader(name, headers[name]);
    head += `${name}: ${headers[name]}\r\n`;
  }
  return encoder.encode(head + '\r\n');
}

interface PooledConn {
  stream: ByteStream;
  dead: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class Http1Client {
  private readonly idle = new Map<string, PooledConn[]>();

  constructor(
    private readonly connect: Connector,
    private readonly opts: { maxIdlePerHost?: number; idleMs?: number; userAgent?: string } = {}
  ) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    const { host, port, target } = parseHttpsUrl(req.url, ['https']);
    const method = req.method.toUpperCase();
    const headers: Record<string, string> = {};
    if (this.opts.userAgent) headers['User-Agent'] = this.opts.userAgent;
    Object.assign(headers, req.headers || {});
    const body = req.body || null;
    if (body || method === 'POST' || method === 'PUT' || method === 'PATCH') {
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-length') delete headers[k];
      headers['Content-Length'] = String(body ? body.length : 0);
    }
    const head = buildRequestHead(method, target, host, port, headers);
    const timeoutMs = req.timeoutMs || DEFAULT_TIMEOUT_MS;
    const maxBytes = req.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES;
    const deadline = Date.now() + timeoutMs;
    const key = `${host}:${port}`;

    const reused = this.takeIdle(key);
    if (reused) {
      try {
        return await this.exchange(key, reused, method, head, body, maxBytes, deadline);
      } catch (e) {
        // A kept-alive socket the server already closed fails before any response byte; retry once on a fresh one.
        if (!(e instanceof StaleConnectionError)) throw e;
      }
    }
    const stream = await this.connect(host, port, Math.max(1000, deadline - Date.now()));
    const conn: PooledConn = { stream, dead: false, idleTimer: null };
    try {
      return await this.exchange(key, conn, method, head, body, maxBytes, deadline);
    } catch (e) {
      if (e instanceof StaleConnectionError) throw new TransportError('network', `connection to ${host} closed before a response`);
      throw e;
    }
  }

  closeAll(): void {
    for (const list of this.idle.values()) for (const c of list) this.discard(c);
    this.idle.clear();
  }

  private takeIdle(key: string): PooledConn | null {
    const list = this.idle.get(key);
    while (list && list.length) {
      const c = list.pop() as PooledConn;
      if (c.idleTimer) clearTimeout(c.idleTimer);
      c.idleTimer = null;
      if (!c.dead) return c;
    }
    return null;
  }

  private release(key: string, conn: PooledConn): void {
    const max = this.opts.maxIdlePerHost ?? 2;
    const list = this.idle.get(key) || [];
    if (conn.dead || list.length >= max) {
      this.discard(conn);
      return;
    }
    conn.stream.onData = () => this.discard(conn);
    conn.stream.onClose = () => {
      conn.dead = true;
    };
    conn.idleTimer = setTimeout(() => this.discard(conn), this.opts.idleMs ?? 30000);
    list.push(conn);
    this.idle.set(key, list);
  }

  private discard(conn: PooledConn): void {
    conn.dead = true;
    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    conn.idleTimer = null;
    conn.stream.onData = null;
    conn.stream.onClose = null;
    conn.stream.close();
  }

  private exchange(
    key: string,
    conn: PooledConn,
    method: string,
    head: Uint8Array,
    body: Uint8Array | null,
    maxBytes: number,
    deadline: number
  ): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const parser = new ResponseParser(method, maxBytes);
      let gotBytes = false;
      let settled = false;
      const stream = conn.stream;

      const timer = setTimeout(() => fail(new TransportError('timeout', 'request timed out')), Math.max(1, deadline - Date.now()));

      function settle() {
        settled = true;
        clearTimeout(timer);
        stream.onData = null;
        stream.onClose = null;
      }

      const fail = (err: Error) => {
        if (settled) return;
        settle();
        this.discard(conn);
        reject(err);
      };

      const succeed = () => {
        if (settled) return;
        const h = parser.head as ResponseHead;
        settle();
        const response: HttpResponse = { status: h.status, statusText: h.statusText, headers: h.headers, body: parser.body() };
        if (parser.reusable && parser.leftover.length === 0) this.release(key, conn);
        else this.discard(conn);
        resolve(response);
      };

      stream.onData = (data) => {
        gotBytes = true;
        try {
          if (parser.feed(data)) succeed();
        } catch (e) {
          fail(e as Error);
        }
      };
      stream.onClose = (err) => {
        if (settled) return;
        conn.dead = true;
        if (!gotBytes && !err) {
          fail(new StaleConnectionError());
          return;
        }
        if (!err && parser.end()) {
          succeed();
          return;
        }
        fail(err || new TransportError('network', 'connection closed before the response was complete'));
      };

      stream.write(head);
      if (body && body.length) writeAll(stream, body).catch((e) => fail(e as Error));
    });
  }
}

class StaleConnectionError extends Error {
  constructor() {
    super('stale keep-alive connection');
  }
}
