/* A TURN client (RFC 8656) over a TCP or TLS stream to one of Signal's relays, so a call's media can flow without UDP sockets: the relay sends and receives UDP for us. */

import type { ByteStream } from '../net/transport/stream';
import {
  addressKey,
  attr,
  decodeStun,
  encodeStun,
  errorCode,
  isStun,
  longTermKey,
  newTransactionId,
  readText,
  readU32,
  readXorAddress,
  SocketAddress,
  StunAttr,
  StunMessage,
  StunType,
  stunLength,
  textAttr,
  u32Attr,
  verifyIntegrity,
  xorAddressAttr,
} from './stun';

const UDP_PROTOCOL = 17;
const REQUEST_TIMEOUT_MS = 5000;
/** Permissions last 300 s and channel bindings 600 s (RFC 8656 sections 9 and 12); refresh well before. */
const PERMISSION_REFRESH_MS = 240_000;
const CHANNEL_MIN = 0x4000;
const CHANNEL_MAX = 0x4ffe;
const MAX_FRAME = 65_535 + 20;

export interface TurnCredentials {
  username: string;
  password: string;
}

export interface Allocation {
  relayed: SocketAddress;
  mapped?: SocketAddress;
  lifetimeSeconds: number;
}

interface Pending {
  resolve: (res: { msg: StunMessage; raw: Uint8Array }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TurnError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'TurnError';
  }
}

/** Splits a TURN-over-TCP byte stream into STUN messages and ChannelData frames (RFC 8656 section 12.5: ChannelData is padded to 4 bytes on streams). */
export class StreamFramer {
  private buf = new Uint8Array(0);

  constructor(private readonly onFrame: (frame: Uint8Array) => void, private readonly onError: (err: Error) => void) {}

  push(data: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + data.length);
    merged.set(this.buf);
    merged.set(data, this.buf.length);
    let off = 0;
    while (merged.length - off >= 4) {
      const first = merged[off];
      let size: number;
      let padded: number;
      if ((first & 0xc0) === 0) {
        size = stunLength(merged.subarray(off));
        padded = size;
      } else if ((first & 0xc0) === 0x40) {
        size = 4 + ((merged[off + 2] << 8) | merged[off + 3]);
        padded = (size + 3) & ~3;
      } else {
        this.buf = new Uint8Array(0);
        this.onError(new TurnError('relay sent an unknown frame'));
        return;
      }
      if (padded > MAX_FRAME) {
        this.buf = new Uint8Array(0);
        this.onError(new TurnError('relay frame too large'));
        return;
      }
      if (merged.length - off < padded) break;
      this.onFrame(merged.slice(off, off + size));
      off += padded;
    }
    this.buf = merged.slice(off);
  }
}

/**
 * One TURN allocation. `onPeerData` receives each UDP datagram the relay got from a peer we gave permission to.
 */
export class TurnClient {
  onPeerData: ((from: SocketAddress, data: Uint8Array) => void) | null = null;
  onClosed: ((err: Error | null) => void) | null = null;

  private pending = new Map<string, Pending>();
  private realm = '';
  private nonce = '';
  private key: Uint8Array | null = null;
  private allocation: Allocation | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private permissions = new Map<string, number>();
  private channels = new Map<string, number>();
  private channelPeers = new Map<number, SocketAddress>();
  private nextChannel = CHANNEL_MIN;
  private closed = false;
  private framer: StreamFramer;

  constructor(private readonly stream: ByteStream, private readonly creds: TurnCredentials, private readonly now: () => number = Date.now) {
    this.framer = new StreamFramer(
      (frame) => this.onFrame(frame),
      (err) => this.close(err)
    );
    stream.onData = (data) => this.framer.push(data);
    stream.onClose = (err) => this.close(err ? new TurnError(err.message) : null);
  }

  get relayed(): SocketAddress | null {
    return this.allocation ? this.allocation.relayed : null;
  }

  get mapped(): SocketAddress | null {
    return (this.allocation && this.allocation.mapped) || null;
  }

  async allocate(): Promise<Allocation> {
    const first = await this.request({ type: StunType.AllocateRequest, transactionId: newTransactionId(), attrs: [u32Attr(StunAttr.RequestedTransport, UDP_PROTOCOL << 24)] });
    let res = first;
    if (first.msg.type === StunType.AllocateError && errorCode(first.msg) === 401) {
      this.takeChallenge(first.msg);
      res = await this.authedRequest(StunType.AllocateRequest, [u32Attr(StunAttr.RequestedTransport, UDP_PROTOCOL << 24)]);
    }
    if (res.msg.type !== StunType.AllocateSuccess) throw new TurnError(`relay refused the allocation (${errorCode(res.msg) || 'no code'})`, errorCode(res.msg));
    const relayed = readXorAddress(attr(res.msg, StunAttr.XorRelayedAddress), res.msg.transactionId);
    if (!relayed) throw new TurnError('relay gave no relayed address');
    const mapped = readXorAddress(attr(res.msg, StunAttr.XorMappedAddress), res.msg.transactionId);
    const lifetimeSeconds = readU32(attr(res.msg, StunAttr.Lifetime)) || 600;
    this.allocation = { relayed, mapped, lifetimeSeconds };
    const every = Math.max(30, Math.min(lifetimeSeconds, 600) / 2) * 1000;
    this.refreshTimer = setInterval(() => this.refresh().catch(() => {}), every);
    return this.allocation;
  }

  /** Lets `peer` send to our relayed address, and binds a channel so each packet costs 4 bytes of framing instead of 36. */
  async permit(peer: SocketAddress): Promise<void> {
    const key = addressKey(peer);
    const last = this.permissions.get(key);
    if (last && this.now() - last < PERMISSION_REFRESH_MS) return;
    this.permissions.set(key, this.now());
    try {
      const res = await this.authedRequest(StunType.CreatePermissionRequest, (tid) => [xorAddressAttr(StunAttr.XorPeerAddress, peer, tid)]);
      if (res.msg.type !== StunType.CreatePermissionSuccess) throw new TurnError(`relay refused a permission (${errorCode(res.msg)})`, errorCode(res.msg));
      let channel = this.channels.get(key);
      if (channel === undefined && this.nextChannel <= CHANNEL_MAX) channel = this.nextChannel++;
      if (channel === undefined) return;
      const bound = await this.authedRequest(StunType.ChannelBindRequest, (tid) => [u32Attr(StunAttr.ChannelNumber, channel! << 16), xorAddressAttr(StunAttr.XorPeerAddress, peer, tid)]);
      if (bound.msg.type === StunType.ChannelBindSuccess) {
        this.channels.set(key, channel);
        this.channelPeers.set(channel, peer);
      }
    } catch (err) {
      this.permissions.delete(key);
      throw err;
    }
  }

  /** Sends one datagram to `peer` through the relay. Returns false when the stream's buffer is full. */
  send(peer: SocketAddress, data: Uint8Array): boolean {
    if (this.closed) return false;
    const channel = this.channels.get(addressKey(peer));
    if (channel !== undefined) {
      const padded = (data.length + 3) & ~3;
      const frame = new Uint8Array(4 + padded);
      const v = new DataView(frame.buffer);
      v.setUint16(0, channel);
      v.setUint16(2, data.length);
      frame.set(data, 4);
      return this.stream.write(frame);
    }
    const tid = newTransactionId();
    return this.stream.write(encodeStun({ type: StunType.SendIndication, transactionId: tid, attrs: [xorAddressAttr(StunAttr.XorPeerAddress, peer, tid), { type: StunAttr.Data, value: data }] }));
  }

  close(err: Error | null = null): void {
    if (this.closed) return;
    this.closed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new TurnError('relay connection closed'));
    }
    this.pending.clear();
    if (!err && this.allocation && this.key) {
      try {
        this.stream.write(this.signed(StunType.RefreshRequest, [u32Attr(StunAttr.Lifetime, 0)]));
      } catch {
        // best effort: the allocation times out on its own
      }
    }
    this.stream.close();
    const cb = this.onClosed;
    this.onClosed = null;
    if (cb) cb(err);
  }

  private async refresh(): Promise<void> {
    const res = await this.authedRequest(StunType.RefreshRequest, [u32Attr(StunAttr.Lifetime, 600)]);
    if (res.msg.type !== StunType.RefreshSuccess) throw new TurnError('relay refused a refresh', errorCode(res.msg));
    const now = this.now();
    for (const [key, at] of this.permissions) {
      if (now - at < PERMISSION_REFRESH_MS) continue;
      const peer = this.peerForKey(key);
      if (peer) this.permit(peer).catch(() => {});
    }
  }

  private peerForKey(key: string): SocketAddress | null {
    const [ip, port] = key.split('|');
    return ip && port ? { ip, port: Number(port) } : null;
  }

  private takeChallenge(msg: StunMessage): void {
    const realm = readText(attr(msg, StunAttr.Realm));
    const nonce = readText(attr(msg, StunAttr.Nonce));
    if (!realm || !nonce) throw new TurnError('relay challenge had no realm or nonce');
    this.realm = realm;
    this.nonce = nonce;
    // SECURITY-REVIEW: the key is derived from the relay password; it stays in memory for this allocation and is never logged.
    this.key = longTermKey(this.creds.username, realm, this.creds.password);
  }

  private signed(type: number, attrs: StunMessage['attrs'] | ((tid: Uint8Array) => StunMessage['attrs']), tid = newTransactionId()): Uint8Array {
    const list = typeof attrs === 'function' ? attrs(tid) : attrs;
    return encodeStun(
      { type, transactionId: tid, attrs: [...list, textAttr(StunAttr.Username, this.creds.username), textAttr(StunAttr.Realm, this.realm), textAttr(StunAttr.Nonce, this.nonce)] },
      this.key!,
      false
    );
  }

  private async authedRequest(type: number, attrs: StunMessage['attrs'] | ((tid: Uint8Array) => StunMessage['attrs'])): Promise<{ msg: StunMessage; raw: Uint8Array }> {
    if (!this.key) throw new TurnError('no relay credentials yet');
    for (let attempt = 0; ; attempt++) {
      const tid = newTransactionId();
      const res = await this.send_(tid, this.signed(type, attrs, tid));
      if ((res.msg.type & 0x0110) === 0x0110 && errorCode(res.msg) === 438 && attempt === 0) {
        const nonce = readText(attr(res.msg, StunAttr.Nonce));
        if (nonce) this.nonce = nonce;
        continue;
      }
      if ((res.msg.type & 0x0110) === 0x0100 && !verifyIntegrity(res.raw, this.key)) throw new TurnError('relay response failed its integrity check');
      return res;
    }
  }

  private request(msg: StunMessage): Promise<{ msg: StunMessage; raw: Uint8Array }> {
    return this.send_(msg.transactionId, encodeStun(msg));
  }

  private send_(tid: Uint8Array, bytes: Uint8Array): Promise<{ msg: StunMessage; raw: Uint8Array }> {
    if (this.closed) return Promise.reject(new TurnError('relay connection closed'));
    const id = hexId(tid);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TurnError('relay did not answer'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.stream.write(bytes);
    });
  }

  private onFrame(frame: Uint8Array): void {
    if ((frame[0] & 0xc0) === 0x40) {
      const channel = (frame[0] << 8) | frame[1];
      const peer = this.channelPeers.get(channel);
      if (peer && this.onPeerData) this.onPeerData(peer, frame.subarray(4));
      return;
    }
    if (!isStun(frame)) return;
    const msg = decodeStun(frame);
    if (!msg) return;
    if (msg.type === StunType.DataIndication) {
      const from = readXorAddress(attr(msg, StunAttr.XorPeerAddress), msg.transactionId);
      const data = attr(msg, StunAttr.Data);
      if (from && data && this.onPeerData) this.onPeerData(from, data);
      return;
    }
    const id = hexId(msg.transactionId);
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve({ msg, raw: frame });
  }
}

function hexId(tid: Uint8Array): string {
  let s = '';
  for (let i = 0; i < tid.length; i++) s += tid[i].toString(16).padStart(2, '0');
  return s;
}
