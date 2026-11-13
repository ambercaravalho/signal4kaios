/* STUN messages (RFC 8489) with the TURN (RFC 8656) and ICE (RFC 8445) attributes a 1:1 call needs. */

import { hmac } from '@noble/hashes/hmac.js';
import { md5, sha1 } from '@noble/hashes/legacy.js';
import { constantTimeEqual } from '../bytes';

export const MAGIC_COOKIE = 0x2112a442;

export const StunType = {
  BindingRequest: 0x0001,
  BindingSuccess: 0x0101,
  BindingError: 0x0111,
  AllocateRequest: 0x0003,
  AllocateSuccess: 0x0103,
  AllocateError: 0x0113,
  RefreshRequest: 0x0004,
  RefreshSuccess: 0x0104,
  RefreshError: 0x0114,
  SendIndication: 0x0016,
  DataIndication: 0x0017,
  CreatePermissionRequest: 0x0008,
  CreatePermissionSuccess: 0x0108,
  CreatePermissionError: 0x0118,
  ChannelBindRequest: 0x0009,
  ChannelBindSuccess: 0x0109,
  ChannelBindError: 0x0119,
} as const;

export const StunAttr = {
  MappedAddress: 0x0001,
  Username: 0x0006,
  MessageIntegrity: 0x0008,
  ErrorCode: 0x0009,
  ChannelNumber: 0x000c,
  Lifetime: 0x000d,
  XorPeerAddress: 0x0012,
  Data: 0x0013,
  Realm: 0x0014,
  Nonce: 0x0015,
  XorRelayedAddress: 0x0016,
  RequestedTransport: 0x0019,
  XorMappedAddress: 0x0020,
  Priority: 0x0024,
  UseCandidate: 0x0025,
  Software: 0x8022,
  Fingerprint: 0x8028,
  IceControlled: 0x8029,
  IceControlling: 0x802a,
  Nomination: 0xc001,
} as const;

export interface StunAttribute {
  type: number;
  value: Uint8Array;
}

export interface StunMessage {
  type: number;
  transactionId: Uint8Array;
  attrs: StunAttribute[];
}

/** An IP address as text (dotted IPv4 or RFC 5952 IPv6) with a port. */
export interface SocketAddress {
  ip: string;
  port: number;
}

const HEADER = 20;
const FINGERPRINT_XOR = 0x5354554e;

export function newTransactionId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(12));
}

export function isStun(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER || (bytes[0] & 0xc0) !== 0) return false;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return v.getUint32(4) === MAGIC_COOKIE;
}

/** The STUN message length in bytes from its header, or -1 when `bytes` is too short to tell. */
export function stunLength(bytes: Uint8Array): number {
  if (bytes.length < 4) return -1;
  return HEADER + ((bytes[2] << 8) | bytes[3]);
}

const pad4 = (n: number) => (n + 3) & ~3;

function serialize(type: number, tid: Uint8Array, attrs: StunAttribute[], extraLength = 0): Uint8Array {
  let len = 0;
  for (const a of attrs) len += 4 + pad4(a.value.length);
  const out = new Uint8Array(HEADER + len);
  const v = new DataView(out.buffer);
  v.setUint16(0, type);
  v.setUint16(2, len + extraLength);
  v.setUint32(4, MAGIC_COOKIE);
  out.set(tid, 8);
  let off = HEADER;
  for (const a of attrs) {
    v.setUint16(off, a.type);
    v.setUint16(off + 2, a.value.length);
    out.set(a.value, off + 4);
    off += 4 + pad4(a.value.length);
  }
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Encodes `msg`, appending MESSAGE-INTEGRITY with `key` when given and FINGERPRINT when asked. */
export function encodeStun(msg: StunMessage, key?: Uint8Array, fingerprint = false): Uint8Array {
  let out = serialize(msg.type, msg.transactionId, msg.attrs, key ? 24 : 0);
  if (key) {
    const mac = hmac(sha1, key, out);
    const attr = new Uint8Array(24);
    new DataView(attr.buffer).setUint32(0, (StunAttr.MessageIntegrity << 16) | 20);
    attr.set(mac, 4);
    out = concat(out, attr);
  }
  if (fingerprint) {
    new DataView(out.buffer).setUint16(2, out.length - HEADER + 8);
    const attr = new Uint8Array(8);
    const v = new DataView(attr.buffer);
    v.setUint32(0, (StunAttr.Fingerprint << 16) | 4);
    v.setUint32(4, (crc32(out) ^ FINGERPRINT_XOR) >>> 0);
    out = concat(out, attr);
  }
  return out;
}

/** Parses a STUN message, or null when `bytes` isn't one. Attribute values are untrusted. */
export function decodeStun(bytes: Uint8Array): StunMessage | null {
  if (!isStun(bytes)) return null;
  const total = stunLength(bytes);
  if (total > bytes.length || (total & 3) !== 0) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, total);
  const attrs: StunAttribute[] = [];
  let off = HEADER;
  while (off + 4 <= total) {
    const type = v.getUint16(off);
    const len = v.getUint16(off + 2);
    if (off + 4 + len > total) return null;
    attrs.push({ type, value: bytes.slice(off + 4, off + 4 + len) });
    off += 4 + pad4(len);
  }
  return { type: v.getUint16(0), transactionId: bytes.slice(8, 20), attrs };
}

export function attr(msg: StunMessage, type: number): Uint8Array | undefined {
  const a = msg.attrs.find((x) => x.type === type);
  return a && a.value;
}

/** Checks MESSAGE-INTEGRITY over the raw message `bytes`, as RFC 8489 section 14.5 computes it. */
export function verifyIntegrity(bytes: Uint8Array, key: Uint8Array): boolean {
  const total = stunLength(bytes);
  if (total < HEADER || total > bytes.length) return false;
  const v = new DataView(bytes.buffer, bytes.byteOffset, total);
  let off = HEADER;
  while (off + 4 <= total) {
    const type = v.getUint16(off);
    const len = v.getUint16(off + 2);
    if (type === StunAttr.MessageIntegrity) {
      if (len !== 20 || off + 24 > total) return false;
      const head = bytes.slice(0, off);
      new DataView(head.buffer).setUint16(2, off + 24 - HEADER);
      return constantTimeEqual(hmac(sha1, key, head), bytes.subarray(off + 4, off + 24));
    }
    off += 4 + pad4(len);
  }
  return false;
}

/** The TURN long-term credential key, MD5(username ":" realm ":" password). */
export function longTermKey(username: string, realm: string, password: string): Uint8Array {
  return md5(new TextEncoder().encode(`${username}:${realm}:${password}`));
}

export function shortTermKey(password: string): Uint8Array {
  return new TextEncoder().encode(password);
}

export function textAttr(type: number, s: string): StunAttribute {
  return { type, value: new TextEncoder().encode(s) };
}

export function u32Attr(type: number, n: number): StunAttribute {
  const value = new Uint8Array(4);
  new DataView(value.buffer).setUint32(0, n >>> 0);
  return { type, value };
}

export function readU32(value: Uint8Array | undefined): number | undefined {
  if (!value || value.length < 4) return undefined;
  return new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(0);
}

export function readText(value: Uint8Array | undefined): string | undefined {
  return value ? new TextDecoder().decode(value) : undefined;
}

/** ERROR-CODE as a number such as 401, or undefined. */
export function errorCode(msg: StunMessage): number | undefined {
  const v = attr(msg, StunAttr.ErrorCode);
  if (!v || v.length < 4) return undefined;
  return (v[2] & 0x7) * 100 + v[3];
}

export function parseIp(ip: string): Uint8Array | null {
  if (ip.includes('.') && !ip.includes(':')) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    const out = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
      if (!/^\d{1,3}$/.test(parts[i])) return null;
      const n = Number(parts[i]);
      if (n > 255) return null;
      out[i] = n;
    }
    return out;
  }
  if (!/^[0-9a-fA-F:]+$/.test(ip)) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...new Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    const n = parseInt(groups[i], 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

export function formatIp(b: Uint8Array): string {
  if (b.length === 4) return Array.from(b).join('.');
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((b[i] << 8) | b[i + 1]).toString(16));
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > bestLen && j - i > 1) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (best < 0) return groups.join(':');
  return groups.slice(0, best).join(':') + '::' + groups.slice(best + bestLen).join(':');
}

export function xorAddressAttr(type: number, addr: SocketAddress, tid: Uint8Array): StunAttribute {
  const ip = parseIp(addr.ip);
  if (!ip) throw new Error('Not an IP address');
  const value = new Uint8Array(4 + ip.length);
  const v = new DataView(value.buffer);
  v.setUint8(1, ip.length === 4 ? 1 : 2);
  v.setUint16(2, addr.port ^ (MAGIC_COOKIE >>> 16));
  const mask = new Uint8Array(16);
  new DataView(mask.buffer).setUint32(0, MAGIC_COOKIE);
  mask.set(tid, 4);
  for (let i = 0; i < ip.length; i++) value[4 + i] = ip[i] ^ mask[i];
  return { type, value };
}

export function readXorAddress(value: Uint8Array | undefined, tid: Uint8Array): SocketAddress | undefined {
  if (!value || value.length < 8) return undefined;
  const family = value[1];
  const len = family === 1 ? 4 : family === 2 ? 16 : 0;
  if (!len || value.length < 4 + len) return undefined;
  const port = (((value[2] << 8) | value[3]) ^ (MAGIC_COOKIE >>> 16)) & 0xffff;
  const mask = new Uint8Array(16);
  new DataView(mask.buffer).setUint32(0, MAGIC_COOKIE);
  mask.set(tid, 4);
  const ip = new Uint8Array(len);
  for (let i = 0; i < len; i++) ip[i] = value[4 + i] ^ mask[i];
  return { ip: formatIp(ip), port };
}

export function sameAddress(a: SocketAddress, b: SocketAddress): boolean {
  return a.port === b.port && a.ip.toLowerCase() === b.ip.toLowerCase();
}

export function addressKey(a: SocketAddress): string {
  return `${a.ip.toLowerCase()}|${a.port}`;
}
