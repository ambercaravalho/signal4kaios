/*
 * A relay-only ICE agent (RFC 8445) for one 1:1 call. KaiOS apps can't open UDP sockets, so our only candidate is the address a TURN relay allocated for us over TCP; connectivity checks with the peer's candidates run through that relay.
 */

import {
  addressKey,
  attr,
  decodeStun,
  encodeStun,
  errorCode,
  isStun,
  newTransactionId,
  parseIp,
  readU32,
  readText,
  shortTermKey,
  SocketAddress,
  StunAttr,
  StunMessage,
  StunType,
  textAttr,
  u32Attr,
  verifyIntegrity,
  xorAddressAttr,
} from './stun';
import type { TurnClient } from './turn';

export interface RemoteCandidate {
  address: SocketAddress;
  priority: number;
  type: string;
}

/** Parses one `candidate:` line from the peer's ICE update. Only UDP candidates for component 1 with a literal IP address are usable through a TURN relay. */
export function parseCandidate(sdp: string): RemoteCandidate | null {
  const line = sdp.trim().replace(/^a=/, '');
  const parts = line.split(/\s+/);
  if (parts.length < 8 || !/^candidate:/.test(parts[0])) return null;
  const [, component, protocol, priority, ip, port, typ, type] = parts;
  if (component !== '1' || protocol.toLowerCase() !== 'udp' || typ !== 'typ') return null;
  if (!parseIp(ip)) return null;
  const portNum = Number(port);
  const prio = Number(priority);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535 || !Number.isInteger(prio) || prio < 0) return null;
  if (!['host', 'srflx', 'prflx', 'relay'].includes(type)) return null;
  return { address: { ip, port: portNum }, priority: prio, type };
}

/** RFC 8445 section 5.1.2.1 with type preference 0 (relayed) and the highest local preference. */
export const RELAY_PRIORITY = (0 << 24) | (65535 << 8) | 255;
const PEER_REFLEXIVE_PRIORITY = ((110 << 24) >>> 0) + (65535 << 8) + 255;

/** Our relayed address as an ICE candidate line, the way WebRTC writes one. The related address is zeroed as WebRTC does when it only relays. */
export function relayCandidateSdp(relayed: SocketAddress, ufrag: string): string {
  return `candidate:1 1 udp ${RELAY_PRIORITY} ${relayed.ip} ${relayed.port} typ relay raddr 0.0.0.0 rport 0 generation 0 ufrag ${ufrag} network-cost 50`;
}

const ICE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function iceString(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let s = '';
  for (let i = 0; i < length; i++) s += ICE_CHARS[bytes[i] & 63];
  return s;
}

interface Pair {
  remote: RemoteCandidate;
  state: 'waiting' | 'inProgress' | 'succeeded' | 'failed';
  lastSent: number;
  attempts: number;
  /** Set once the peer's check on this pair arrived, which a nomination from the peer requires. */
  heardFrom: boolean;
}

interface Pending {
  key: string;
  nominate: boolean;
  sentAt: number;
}

export interface IceAgentOptions {
  turn: TurnClient;
  controlling: boolean;
  localUfrag: string;
  localPwd: string;
  now?: () => number;
  /** How long checks may run before the agent gives up. */
  timeoutMs?: number;
}

const CHECK_INTERVAL_MS = 50;
const RETRANSMIT_MS = 500;
const MAX_ATTEMPTS = 40;
const KEEPALIVE_MS = 2000;
/** RFC 7675 consent: without an answer for this long, the path is gone. */
const CONSENT_TIMEOUT_MS = 30_000;
const MAX_REMOTE_CANDIDATES = 30;

export class IceAgent {
  onConnected: (() => void) | null = null;
  onFailed: ((reason: string) => void) | null = null;
  /** Non-STUN datagrams (SRTP and SRTCP) from the peer. */
  onPacket: ((data: Uint8Array) => void) | null = null;

  private remoteUfrag = '';
  private remotePwd = '';
  private pairs = new Map<string, Pair>();
  private pending = new Map<string, Pending>();
  private selected: string | null = null;
  private nominationSeen = 0;
  private lastConsent = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = 0;
  private closed = false;
  private controlling: boolean;
  private readonly tiebreaker = crypto.getRandomValues(new Uint8Array(8));
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: IceAgentOptions) {
    this.controlling = opts.controlling;
    this.now = opts.now || Date.now;
    this.timeoutMs = opts.timeoutMs || 30_000;
  }

  get connected(): boolean {
    return this.selected !== null;
  }

  /** The candidate pairs' types and states, without addresses, for the debug log. */
  summary(): string {
    const pairs: string[] = [];
    for (const [key, p] of this.pairs) pairs.push(`${p.remote.type}:${p.state}${key === this.selected ? '*' : ''}${p.heardFrom ? '+' : ''}/${p.attempts}`);
    return `${this.controlling ? 'controlling' : 'controlled'} ${pairs.join(' ') || 'no candidates'}`;
  }

  start(): void {
    if (this.timer || this.closed) return;
    this.started = this.now();
    this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
  }

  setRemoteCredentials(ufrag: string, pwd: string): void {
    this.remoteUfrag = ufrag;
    this.remotePwd = pwd;
  }

  addRemoteCandidate(c: RemoteCandidate): void {
    const key = addressKey(c.address);
    if (this.pairs.has(key) || this.pairs.size >= MAX_REMOTE_CANDIDATES || this.closed) return;
    this.pairs.set(key, { remote: c, state: 'waiting', lastSent: 0, attempts: 0, heardFrom: false });
    this.opts.turn.permit(c.address).catch(() => {});
  }

  removeRemoteAddress(address: SocketAddress): void {
    const key = addressKey(address);
    if (key === this.selected) return;
    this.pairs.delete(key);
  }

  /** Sends one SRTP datagram on the selected pair. */
  send(data: Uint8Array): boolean {
    if (!this.selected) return false;
    const pair = this.pairs.get(this.selected);
    return !!pair && this.opts.turn.send(pair.remote.address, data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Takes a datagram the relay received when it belongs to this agent: a check addressed to our credentials and the peer's, a response to one of our checks, or media from a known candidate. */
  receive(from: SocketAddress, data: Uint8Array): boolean {
    if (this.closed) return false;
    if (!isStun(data)) {
      if (!this.pairs.has(addressKey(from))) return false;
      if (this.onPacket) this.onPacket(data);
      return true;
    }
    const msg = decodeStun(data);
    if (!msg) return false;
    if (msg.type === StunType.BindingRequest) {
      const username = readText(attr(msg, StunAttr.Username)) || '';
      if (username !== `${this.opts.localUfrag}:${this.remoteUfrag}`) return false;
      this.onRequest(from, msg, data);
      return true;
    }
    if ((msg.type === StunType.BindingSuccess || msg.type === StunType.BindingError) && this.pending.has(hex(msg.transactionId))) {
      this.onResponse(from, msg, data);
      return true;
    }
    return false;
  }

  private tick(): void {
    if (this.closed || !this.remotePwd) return;
    const now = this.now();
    if (this.selected) {
      const pair = this.pairs.get(this.selected)!;
      if (now - pair.lastSent >= KEEPALIVE_MS) this.sendCheck(this.selected, pair, false);
      if (now - this.lastConsent > CONSENT_TIMEOUT_MS) this.fail('the call lost its connection');
      return;
    }
    if (now - this.started > this.timeoutMs) {
      this.fail('could not connect the call');
      return;
    }
    // One check per tick (RFC 8445 Ta pacing), highest priority first, then retransmissions.
    let best: [string, Pair] | null = null;
    for (const entry of this.pairs) {
      const p = entry[1];
      if (p.state === 'failed') continue;
      const due = p.state === 'waiting' || ((p.state === 'inProgress' || p.state === 'succeeded') && now - p.lastSent >= RETRANSMIT_MS);
      if (!due) continue;
      if (!best || p.remote.priority > best[1].remote.priority || (best[1].state !== 'waiting' && p.state === 'waiting')) best = entry;
    }
    if (best) {
      const [key, pair] = best;
      if (pair.attempts >= MAX_ATTEMPTS) {
        pair.state = 'failed';
        return;
      }
      this.sendCheck(key, pair, this.controlling && pair.state === 'succeeded');
    }
  }

  private sendCheck(key: string, pair: Pair, nominate: boolean): void {
    const tid = newTransactionId();
    const attrs = [
      textAttr(StunAttr.Username, `${this.remoteUfrag}:${this.opts.localUfrag}`),
      u32Attr(StunAttr.Priority, PEER_REFLEXIVE_PRIORITY),
      { type: this.controlling ? StunAttr.IceControlling : StunAttr.IceControlled, value: this.tiebreaker },
    ];
    if (nominate) {
      attrs.push({ type: StunAttr.UseCandidate, value: new Uint8Array(0) });
      attrs.push(u32Attr(StunAttr.Nomination, 1));
    }
    const bytes = encodeStun({ type: StunType.BindingRequest, transactionId: tid, attrs }, shortTermKey(this.remotePwd), true);
    const id = hex(tid);
    this.pending.set(id, { key, nominate, sentAt: this.now() });
    if (this.pending.size > 200) this.pending.delete(this.pending.keys().next().value!);
    pair.lastSent = this.now();
    pair.attempts++;
    if (pair.state === 'waiting') pair.state = 'inProgress';
    this.opts.turn.send(pair.remote.address, bytes);
  }

  private onRequest(from: SocketAddress, msg: StunMessage, raw: Uint8Array): void {
    if (!verifyIntegrity(raw, shortTermKey(this.opts.localPwd))) return;
    const theyControl = !!attr(msg, StunAttr.IceControlling);
    if (theyControl === this.controlling) {
      const theirs = attr(msg, theyControl ? StunAttr.IceControlling : StunAttr.IceControlled);
      const weWin = !!theirs && compareBytes(this.tiebreaker, theirs) >= 0;
      if (this.controlling === weWin) {
        this.respond(from, msg, 487);
        return;
      }
      this.controlling = !this.controlling;
    }
    const key = addressKey(from);
    let pair = this.pairs.get(key);
    if (!pair) {
      if (this.pairs.size >= MAX_REMOTE_CANDIDATES) return;
      pair = { remote: { address: from, priority: readU32(attr(msg, StunAttr.Priority)) || 0, type: 'prflx' }, state: 'waiting', lastSent: 0, attempts: 0, heardFrom: false };
      this.pairs.set(key, pair);
      this.opts.turn.permit(from).catch(() => {});
    }
    pair.heardFrom = true;
    this.respond(from, msg, 0);
    if (pair.state === 'waiting' || pair.state === 'failed') {
      pair.state = 'waiting';
      pair.attempts = 0;
    }
    if (!this.controlling && attr(msg, StunAttr.UseCandidate)) {
      const nomination = readU32(attr(msg, StunAttr.Nomination)) || 1;
      if (nomination >= this.nominationSeen) {
        this.nominationSeen = nomination;
        this.select(key);
      }
    }
  }

  private respond(to: SocketAddress, req: StunMessage, error: number): void {
    const tid = req.transactionId;
    const msg: StunMessage = error
      ? { type: StunType.BindingError, transactionId: tid, attrs: [{ type: StunAttr.ErrorCode, value: errorValue(error) }] }
      : { type: StunType.BindingSuccess, transactionId: tid, attrs: [xorAddressAttr(StunAttr.XorMappedAddress, to, tid)] };
    this.opts.turn.send(to, encodeStun(msg, shortTermKey(this.opts.localPwd), true));
  }

  private onResponse(from: SocketAddress, msg: StunMessage, raw: Uint8Array): void {
    const id = hex(msg.transactionId);
    const p = this.pending.get(id);
    if (!p || !verifyIntegrity(raw, shortTermKey(this.remotePwd))) return;
    this.pending.delete(id);
    const pair = this.pairs.get(p.key);
    if (!pair || addressKey(from) !== p.key) return;
    if (msg.type === StunType.BindingError) {
      if (errorCode(msg) === 487) {
        this.controlling = !this.controlling;
        pair.state = 'waiting';
      } else {
        pair.state = 'failed';
      }
      return;
    }
    this.lastConsent = this.now();
    pair.state = 'succeeded';
    if (this.controlling && p.nominate) this.select(p.key);
    else if (this.controlling) this.sendCheck(p.key, pair, true);
  }

  private select(key: string): void {
    const first = this.selected === null;
    this.selected = key;
    this.lastConsent = this.now();
    if (first && this.onConnected) this.onConnected();
  }

  private fail(reason: string): void {
    const cb = this.onFailed;
    this.close();
    if (cb) cb(reason);
  }
}

/** Shares one relay allocation between the agents of an outgoing call, one per callee device that answered, as RingRTC's outgoing parent shares one ICE gatherer. */
export class RelayMux {
  private agents = new Set<IceAgent>();

  constructor(readonly turn: TurnClient) {
    turn.onPeerData = (from, data) => {
      for (const a of this.agents) if (a.receive(from, data)) return;
    };
  }

  add(agent: IceAgent): void {
    this.agents.add(agent);
  }

  remove(agent: IceAgent): void {
    this.agents.delete(agent);
  }
}

function errorValue(code: number): Uint8Array {
  const reason = new TextEncoder().encode(code === 487 ? 'Role Conflict' : 'Bad Request');
  const v = new Uint8Array(4 + reason.length);
  v[2] = Math.floor(code / 100);
  v[3] = code % 100;
  v.set(reason, 4);
  return v;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function hex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}
