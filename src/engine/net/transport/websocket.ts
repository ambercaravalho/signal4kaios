/** RFC 6455 client over a pinned TLS `ByteStream`, shaped like the browser `WebSocket` so `ws.js` and provisioning can use either. Frames from the server are untrusted: sizes are capped and protocol violations close the socket. */

import { sha1 } from '@noble/hashes/legacy.js';

import { toBase64 } from '../../bytes';
import { parseHttpsUrl, parseResponseHead, buildRequestHead } from './http1';
import { ByteStream, concatBytes, Connector, TransportError } from './stream';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const CLOSE_TIMEOUT_MS = 3000;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

interface CloseEventLike {
  code: number;
  reason: string;
  wasClean: boolean;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function websocketAccept(key: string): string {
  return toBase64(sha1(new TextEncoder().encode(key + WS_GUID)));
}

/** Encodes one masked client frame. */
export function encodeFrame(opcode: number, payload: Uint8Array, mask: Uint8Array = randomBytes(4)): Uint8Array {
  const len = payload.length;
  const headerLen = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const out = new Uint8Array(headerLen + 4 + len);
  out[0] = 0x80 | opcode;
  if (len < 126) {
    out[1] = 0x80 | len;
  } else if (len < 65536) {
    out[1] = 0x80 | 126;
    out[2] = len >>> 8;
    out[3] = len & 0xff;
  } else {
    out[1] = 0x80 | 127;
    const hi = Math.floor(len / 0x100000000);
    const lo = len >>> 0;
    out[2] = (hi >>> 24) & 0xff;
    out[3] = (hi >>> 16) & 0xff;
    out[4] = (hi >>> 8) & 0xff;
    out[5] = hi & 0xff;
    out[6] = (lo >>> 24) & 0xff;
    out[7] = (lo >>> 16) & 0xff;
    out[8] = (lo >>> 8) & 0xff;
    out[9] = lo & 0xff;
  }
  out.set(mask, headerLen);
  const start = headerLen + 4;
  for (let i = 0; i < len; i++) out[start + i] = payload[i] ^ mask[i & 3];
  return out;
}

export interface DecodedFrame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
  length: number;
}

/** Decodes one unmasked server frame from the front of `buf`; returns null while incomplete. */
export function decodeFrame(buf: Uint8Array): DecodedFrame | null {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  if (buf[0] & 0x70) throw new TransportError('protocol', 'reserved WebSocket bits set');
  const opcode = buf[0] & 0x0f;
  if (buf[1] & 0x80) throw new TransportError('protocol', 'server frames must not be masked');
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = (buf[2] << 8) | buf[3];
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    if (buf[2] || buf[3] || buf[4] || buf[5]) throw new TransportError('protocol', 'WebSocket frame is too large');
    len = ((buf[6] << 24) >>> 0) + (buf[7] << 16) + (buf[8] << 8) + buf[9];
    offset = 10;
  }
  if (len > MAX_MESSAGE_BYTES) throw new TransportError('protocol', 'WebSocket frame is too large');
  if (opcode >= 0x8 && (len > 125 || !fin)) throw new TransportError('protocol', 'invalid WebSocket control frame');
  if (buf.length < offset + len) return null;
  return { fin, opcode, payload: buf.slice(offset, offset + len), length: offset + len };
}

export class PinnedWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = 0;
  binaryType: 'arraybuffer' = 'arraybuffer';
  readonly bufferedAmount = 0;
  onopen: ((evt: unknown) => void) | null = null;
  onmessage: ((evt: { data: ArrayBuffer | string }) => void) | null = null;
  onerror: ((evt: unknown) => void) | null = null;
  onclose: ((evt: CloseEventLike) => void) | null = null;

  private stream: ByteStream | null = null;
  private buf: Uint8Array = new Uint8Array(0);
  private fragments: Uint8Array[] = [];
  private fragmentOpcode = 0;
  private fragmentSize = 0;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private closeSent = false;
  private finished = false;

  constructor(url: string, connect: Connector, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}) {
    let parsed: ReturnType<typeof parseHttpsUrl>;
    try {
      parsed = parseHttpsUrl(url, ['wss']);
    } catch (e) {
      throw new SyntaxError((e as Error).message);
    }
    const { host, port, target } = parsed;
    const timeoutMs = opts.timeoutMs || 20000;
    const key = toBase64(randomBytes(16));
    // SECURITY-REVIEW: `target` can carry the account login and password (main socket query string); it is only written to the TLS stream, never logged or put in errors.
    const head = buildRequestHead('GET', target, host, port, {
      ...(opts.headers || {}),
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    });

    const started = Date.now();
    connect(host, port, timeoutMs).then(
      (stream) => {
        if (this.finished) {
          stream.close();
          return;
        }
        this.stream = stream;
        stream.onClose = (err) => this.fail(err && err.kind === 'tls' ? 1015 : 1006, err ? err.message : 'connection lost');
        const upgradeTimer = setTimeout(() => this.fail(1006, 'WebSocket upgrade timed out'), Math.max(1000, timeoutMs - (Date.now() - started)));
        stream.onData = (data) => {
          this.buf = concatBytes(this.buf, data);
          let resHead;
          try {
            resHead = parseResponseHead(this.buf);
          } catch (e) {
            clearTimeout(upgradeTimer);
            this.fail(1002, (e as Error).message);
            return;
          }
          if (!resHead) return;
          clearTimeout(upgradeTimer);
          if (resHead.status !== 101) {
            const code = resHead.status === 401 ? 4001 : resHead.status === 403 ? 4003 : 1006;
            this.fail(code, `WebSocket upgrade failed (HTTP ${resHead.status})`);
            return;
          }
          if ((resHead.headers['upgrade'] || '').toLowerCase() !== 'websocket' || resHead.headers['sec-websocket-accept'] !== websocketAccept(key)) {
            this.fail(1002, 'invalid WebSocket upgrade response');
            return;
          }
          this.buf = this.buf.subarray(resHead.length);
          this.readyState = PinnedWebSocket.OPEN;
          stream.onData = (more) => this.onBytes(more);
          if (this.onopen) this.onopen({ type: 'open' });
          if (this.buf.length) this.onBytes(new Uint8Array(0));
        };
        stream.write(head);
      },
      (err: TransportError) => this.fail(err && err.kind === 'tls' ? 1015 : 1006, (err && err.message) || 'connection failed')
    );
  }

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (this.readyState === PinnedWebSocket.CONNECTING) throw new Error('InvalidStateError: WebSocket is still connecting');
    if (this.readyState !== PinnedWebSocket.OPEN || !this.stream) return;
    let payload: Uint8Array;
    let opcode = OP_BINARY;
    if (typeof data === 'string') {
      payload = new TextEncoder().encode(data);
      opcode = OP_TEXT;
    } else if (data instanceof ArrayBuffer) {
      payload = new Uint8Array(data);
    } else {
      payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    this.stream.write(encodeFrame(opcode, payload));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === PinnedWebSocket.CLOSING || this.readyState === PinnedWebSocket.CLOSED) return;
    if (!this.stream) {
      this.finish(code, reason, false);
      return;
    }
    this.readyState = PinnedWebSocket.CLOSING;
    this.sendClose(code, reason);
    this.closeTimer = setTimeout(() => this.finish(code, reason, false), CLOSE_TIMEOUT_MS);
  }

  private sendClose(code: number, reason: string): void {
    if (this.closeSent || !this.stream) return;
    this.closeSent = true;
    const reasonBytes = new TextEncoder().encode(reason).subarray(0, 123);
    const payload = new Uint8Array(2 + reasonBytes.length);
    payload[0] = code >>> 8;
    payload[1] = code & 0xff;
    payload.set(reasonBytes, 2);
    this.stream.write(encodeFrame(OP_CLOSE, payload));
  }

  private onBytes(data: Uint8Array): void {
    this.buf = concatBytes(this.buf, data);
    try {
      for (;;) {
        if (this.finished) return;
        const frame = decodeFrame(this.buf);
        if (!frame) return;
        this.buf = this.buf.subarray(frame.length);
        this.handleFrame(frame);
      }
    } catch (e) {
      this.fail(1002, (e as Error).message);
    }
  }

  private handleFrame(frame: DecodedFrame): void {
    switch (frame.opcode) {
      case OP_PING:
        if (this.stream && this.readyState === PinnedWebSocket.OPEN) this.stream.write(encodeFrame(OP_PONG, frame.payload));
        return;
      case OP_PONG:
        return;
      case OP_CLOSE: {
        const p = frame.payload;
        const code = p.length >= 2 ? (p[0] << 8) | p[1] : 1005;
        const reason = p.length > 2 ? new TextDecoder().decode(p.subarray(2)) : '';
        this.sendClose(code === 1005 ? 1000 : code, '');
        this.finish(code, reason, true);
        return;
      }
      case OP_TEXT:
      case OP_BINARY:
        if (this.fragments.length) throw new TransportError('protocol', 'new WebSocket message before the previous one finished');
        if (frame.fin) {
          this.deliver(frame.opcode, frame.payload);
          return;
        }
        this.fragmentOpcode = frame.opcode;
        this.fragments = [frame.payload];
        this.fragmentSize = frame.payload.length;
        return;
      case OP_CONTINUATION: {
        if (!this.fragments.length) throw new TransportError('protocol', 'unexpected WebSocket continuation frame');
        this.fragmentSize += frame.payload.length;
        if (this.fragmentSize > MAX_MESSAGE_BYTES) throw new TransportError('protocol', 'WebSocket message is too large');
        this.fragments.push(frame.payload);
        if (!frame.fin) return;
        const whole = new Uint8Array(this.fragmentSize);
        let offset = 0;
        for (const f of this.fragments) {
          whole.set(f, offset);
          offset += f.length;
        }
        this.fragments = [];
        this.fragmentSize = 0;
        this.deliver(this.fragmentOpcode, whole);
        return;
      }
      default:
        throw new TransportError('protocol', `unknown WebSocket opcode ${frame.opcode}`);
    }
  }

  private deliver(opcode: number, payload: Uint8Array): void {
    if (this.readyState !== PinnedWebSocket.OPEN || !this.onmessage) return;
    if (opcode === OP_TEXT) {
      this.onmessage({ data: new TextDecoder().decode(payload) });
    } else {
      this.onmessage({ data: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer });
    }
  }

  private fail(code: number, reason: string): void {
    if (this.finished) return;
    if (this.onerror) this.onerror({ type: 'error' });
    this.finish(code, reason, false);
  }

  private finish(code: number, reason: string, wasClean: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.readyState = PinnedWebSocket.CLOSED;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    if (this.stream) {
      this.stream.onData = null;
      this.stream.onClose = null;
      this.stream.close();
      this.stream = null;
    }
    const cb = this.onclose;
    if (cb) cb({ code, reason, wasClean });
  }
}
