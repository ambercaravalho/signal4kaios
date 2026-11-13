/* 1:1 voice calls, following RingRTC's call manager and call state machine (call_manager.rs, call_fsm.rs) for how offers, answers, ICE, hangups, busy, glare, and timeouts are handled, so Beacon behaves like any other Signal device in the call. */

import { create, fromBinary, toBinary } from '../net/proto';
import {
  CallMessage_AnswerSchema,
  CallMessage_BusySchema,
  CallMessage_Hangup_Type,
  CallMessage_HangupSchema,
  CallMessage_IceUpdateSchema,
  CallMessage_Offer_Type,
  CallMessage_OfferSchema,
  CallMessageSchema,
  type CallMessage,
} from '../gen/SignalService_pb';
import {
  AnswerSchema,
  ConnectionParametersV4Schema,
  IceCandidateSchema,
  IceCandidateV3Schema,
  OfferSchema,
  VideoCodecSchema,
  VideoCodecType,
  type ConnectionParametersV4,
} from '../gen/signaling_pb';
import { Hangup_Type as RtpHangupType } from '../gen/rtp_data_pb';
import { CallConnection, type Srtp } from './connection';
import { IceAgent, iceString, parseCandidate, relayCandidateSdp, RelayMux } from './ice';
import { CallAudio } from './media';
import { parseIp } from './stun';
import type { TurnClient } from './turn';

/** RingRTC drops offers older than this (`MAX_MESSAGE_AGE`) and the app shows them as missed. */
export const MAX_OFFER_AGE_MS = 60_000;
/** RingRTC's ringing timeout (`TIME_OUT_PERIOD`). */
export const RING_TIMEOUT_MS = 60_000;
/** RingRTC asks for 2 Mbps in 1:1 calls; audio uses a sliver of it. */
const MAX_BITRATE_BPS = 2_000_000n;
const MAX_PENDING_ICE = 40;

export type CallDirection = 'incoming' | 'outgoing';
/** `incoming`: ringing here. `outgoing`: reaching the peer. `ringing`: the peer's device is ringing. `connecting`: answered, waiting for the network path. */
export type CallPhase = 'incoming' | 'outgoing' | 'ringing' | 'connecting' | 'connected' | 'ended';
export type CallEndReason =
  | 'hungUp'
  | 'remoteHungUp'
  | 'declined'
  | 'remoteDeclined'
  | 'missed'
  | 'busy'
  | 'noAnswer'
  | 'acceptedElsewhere'
  | 'declinedElsewhere'
  | 'busyElsewhere'
  | 'needPermission'
  | 'failed';

export interface CallState {
  callId: string;
  peer: string;
  direction: CallDirection;
  phase: CallPhase;
  muted: boolean;
  remoteMuted: boolean;
  startedAt: number;
  connectedAt: number | null;
  endReason: CallEndReason | null;
}

/** One finished call, for the chat's call line and the call log sync. */
export interface CallRecord {
  callId: string;
  peer: string;
  direction: CallDirection;
  outcome: 'accepted' | 'declined' | 'missed' | 'unanswered';
  timestamp: number;
  durationMs: number;
}

export interface CallKeys {
  publicKey(): Uint8Array;
  srtp(remotePublicKey: Uint8Array, callerIdentity: Uint8Array, calleeIdentity: Uint8Array, weAreCaller: boolean): Srtp;
  free?(): void;
}

export interface CallDeps {
  self(): Promise<{ aci: string; deviceId: number }>;
  send(peer: string, msg: CallMessage, urgent: boolean): Promise<void>;
  identityKeys(peer: string): Promise<{ ours: Uint8Array; theirs: Uint8Array } | null>;
  openRelay(): Promise<TurnClient>;
  newKeys(): CallKeys;
  newAudio(): CallAudio;
  /** The call's line in the chat; sent again with the final outcome, keyed by call ID. */
  record(rec: CallRecord): void;
  /** `SyncMessage.callEvent` to our other devices, as Desktop sends for answered, declined, and placed calls. */
  syncEvent(rec: CallRecord, event: 'accepted' | 'notAccepted'): void;
  log(msg: string): void;
  now?(): number;
}

export interface CallEnvelope {
  source: string;
  sourceDevice: number;
  serverTimestamp: number;
}

interface Leg {
  deviceId: number;
  conn: CallConnection | null;
  ice: IceAgent | null;
  pendingIce: Uint8Array[];
  failed: boolean;
}

interface Call {
  id: bigint;
  peer: string;
  direction: CallDirection;
  phase: CallPhase;
  legs: Map<number, Leg>;
  /** The caller's device for an incoming call; the device that answered for an outgoing one. */
  activeDevice: number | null;
  accepted: boolean;
  offerSent: boolean;
  muted: boolean;
  remoteMuted: boolean;
  startedAt: number;
  connectedAt: number | null;
  endReason: CallEndReason | null;
  timer: ReturnType<typeof setTimeout> | null;
  turn: TurnClient | null;
  mux: RelayMux | null;
  keys: CallKeys | null;
  ufrag: string;
  pwd: string;
  audio: CallAudio | null;
  identity: { ours: Uint8Array; theirs: Uint8Array } | null;
  remote: ConnectionParametersV4 | null;
  recorded: boolean;
}

type Listener = (state: CallState | null) => void;

export class CallManager {
  private call: Call | null = null;
  private listeners = new Set<Listener>();
  private ourDevice = -1;
  private readonly now: () => number;

  constructor(private readonly deps: CallDeps) {
    this.now = deps.now || Date.now;
  }

  get state(): CallState | null {
    return this.call ? this.snapshot(this.call) : null;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Microphone samples from the app, at `CALL_SAMPLE_RATE`. */
  capture(pcm: Float32Array): void {
    const c = this.call;
    if (c && c.audio && c.accepted && c.phase !== 'ended') c.audio.capture(pcm);
  }

  /** The peer's audio for the speaker, or null while there is none. */
  pull(): Float32Array | null {
    const c = this.call;
    return c && c.audio && c.phase === 'connected' ? c.audio.pull() : null;
  }

  /** Handles a `CallMessage` from a decrypted envelope. Returns true when it was a voice call message this manager took; video offers are left to the caller to show. */
  async handle(env: CallEnvelope, msg: CallMessage): Promise<boolean> {
    const me = await this.deps.self();
    if (msg.destinationDeviceId && msg.destinationDeviceId !== me.deviceId) return true;
    this.ourDevice = me.deviceId;
    if (msg.offer) {
      if (msg.offer.type === CallMessage_Offer_Type.OFFER_VIDEO_CALL) return false;
      this.onOffer(env, msg.offer.id, msg.offer.opaque);
      return true;
    }
    if (msg.answer) this.onAnswer(env, msg.answer.id, msg.answer.opaque);
    if (msg.iceUpdate.length) this.onIce(env, msg.iceUpdate.map((u) => ({ id: u.id, opaque: u.opaque })));
    if (msg.busy) this.onBusy(env, msg.busy.id);
    if (msg.hangup) this.onHangup(env, msg.hangup.id, msg.hangup.type, msg.hangup.deviceId);
    return true;
  }

  async startCall(peer: string): Promise<void> {
    if (this.call) throw new Error('already in a call');
    const id = newCallId();
    const c = this.newCall(id, peer, 'outgoing', null);
    this.call = c;
    this.emit();
    try {
      c.identity = await this.deps.identityKeys(peer);
      if (!c.identity) throw new Error('no session with this contact yet');
      await this.openMedia(c);
      if (this.call !== c) return;
      const offer = create(OfferSchema, { v4: this.localParams(c) });
      await this.deps.send(peer, create(CallMessageSchema, { offer: create(CallMessage_OfferSchema, { id, type: CallMessage_Offer_Type.OFFER_AUDIO_CALL, opaque: toBinary(OfferSchema, offer) }) }), true);
      if (this.call !== c) return;
      c.offerSent = true;
      this.sendIce(c, 0);
      this.deps.syncEvent(this.recordFor(c, 'accepted'), 'accepted');
      c.timer = setTimeout(() => this.onTimeout(c), RING_TIMEOUT_MS);
    } catch (err) {
      this.deps.log(`call: could not start (${errText(err)})`);
      this.end(c, 'failed');
    }
  }

  accept(): void {
    const c = this.call;
    if (!c || c.direction !== 'incoming' || c.phase !== 'incoming') return;
    c.accepted = true;
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    const leg = this.activeLeg(c);
    if (leg && leg.conn) {
      leg.conn.sendAccepted();
      leg.conn.setSendingAudio(true);
    }
    c.phase = leg && leg.ice && leg.ice.connected ? 'connected' : 'connecting';
    if (c.phase === 'connected') c.connectedAt = this.now();
    this.deps.syncEvent(this.recordFor(c, 'accepted'), 'accepted');
    this.emit();
  }

  decline(): void {
    const c = this.call;
    if (!c || c.direction !== 'incoming' || c.phase !== 'incoming') return;
    this.deps.syncEvent(this.recordFor(c, 'declined'), 'notAccepted');
    this.hangupAll(c, CallMessage_Hangup_Type.HANGUP_NORMAL, 0);
    this.end(c, 'declined');
  }

  /** Ends a ringing call here without telling the caller, as Signal-Desktop does for a chat whose message request isn't accepted. */
  ignore(): void {
    const c = this.call;
    if (!c || c.direction !== 'incoming' || c.phase !== 'incoming') return;
    this.end(c, 'missed');
  }

  /** Another of our devices answered or declined the call ringing here, as its `SyncMessage.callEvent` says. */
  answeredElsewhere(callId: string, accepted: boolean): void {
    const c = this.call;
    if (!c || c.id.toString() !== callId || c.direction !== 'incoming' || c.phase !== 'incoming') return;
    this.end(c, accepted ? 'acceptedElsewhere' : 'declinedElsewhere');
  }

  hangup(): void {
    const c = this.call;
    if (!c || c.phase === 'ended') return;
    if (c.direction === 'incoming' && c.phase === 'incoming') {
      this.decline();
      return;
    }
    if (c.direction === 'incoming' || c.offerSent) this.hangupAll(c, CallMessage_Hangup_Type.HANGUP_NORMAL, 0);
    this.end(c, 'hungUp');
  }

  setMuted(muted: boolean): void {
    const c = this.call;
    if (!c || c.muted === muted) return;
    c.muted = muted;
    if (c.audio) c.audio.muted = muted;
    const leg = this.activeLeg(c);
    if (leg && leg.conn) leg.conn.sendAudioEnabled(!muted);
    this.emit();
  }

  /** Clears an ended call from view. */
  dismiss(): void {
    if (this.call && this.call.phase === 'ended') {
      this.call = null;
      this.emit();
    }
  }

  private newCall(id: bigint, peer: string, direction: CallDirection, activeDevice: number | null): Call {
    return {
      id,
      peer,
      direction,
      phase: direction,
      legs: new Map(),
      activeDevice,
      accepted: false,
      offerSent: false,
      muted: false,
      remoteMuted: false,
      startedAt: this.now(),
      connectedAt: null,
      endReason: null,
      timer: null,
      turn: null,
      mux: null,
      keys: null,
      ufrag: iceString(4),
      pwd: iceString(22),
      audio: null,
      identity: null,
      remote: null,
      recorded: false,
    };
  }

  private onOffer(env: CallEnvelope, id: bigint, opaque: Uint8Array): void {
    const age = Math.max(0, this.now() - env.serverTimestamp);
    if (age > MAX_OFFER_AGE_MS) {
      this.deps.record({ callId: id.toString(), peer: env.source, direction: 'incoming', outcome: 'missed', timestamp: env.serverTimestamp || this.now(), durationMs: 0 });
      return;
    }
    const remote = parseParams(opaque, 'offer');
    if (!remote || !id) {
      this.deps.log('call: dropped an offer without usable V4 parameters');
      return;
    }
    const active = this.call;
    if (active && active.phase !== 'ended') {
      const collision = this.collision(active, env, id);
      if (collision === 'busy' || collision === 'doubleLoser') {
        this.sendTo(env.source, env.sourceDevice, { busy: create(CallMessage_BusySchema, { id }) });
        this.deps.record({ callId: id.toString(), peer: env.source, direction: 'incoming', outcome: 'missed', timestamp: this.now(), durationMs: 0 });
      }
      if (collision === 'loser' || collision === 'doubleLoser') {
        this.hangupAll(active, CallMessage_Hangup_Type.HANGUP_NORMAL, 0);
        this.end(active, 'failed');
      }
      if (collision === 'recall') this.end(active, 'remoteHungUp');
      if (collision === 'busy' || collision === 'winner' || collision === 'doubleLoser') return;
    }
    const c = this.newCall(id, env.source, 'incoming', env.sourceDevice);
    c.remote = remote;
    c.legs.set(env.sourceDevice, { deviceId: env.sourceDevice, conn: null, ice: null, pendingIce: [], failed: false });
    this.call = c;
    c.timer = setTimeout(() => this.onTimeout(c), RING_TIMEOUT_MS);
    this.emit();
    void this.answer(c, env, remote);
  }

  /** Runs apart from message handling, so the ICE updates that follow an offer aren't held up behind the relay. */
  private async answer(c: Call, env: CallEnvelope, remote: ConnectionParametersV4): Promise<void> {
    const id = c.id;
    try {
      c.identity = await this.deps.identityKeys(env.source);
      if (!c.identity) throw new Error('no identity key for the caller');
      await this.openMedia(c);
      if (this.call !== c || c.phase === 'ended') return;
      this.connectLeg(c, env.sourceDevice, remote);
      const answer = create(AnswerSchema, { v4: this.localParams(c) });
      await this.deps.send(c.peer, create(CallMessageSchema, { answer: create(CallMessage_AnswerSchema, { id, opaque: toBinary(AnswerSchema, answer) }), destinationDeviceId: env.sourceDevice }), false);
      this.sendIce(c, env.sourceDevice);
    } catch (err) {
      this.deps.log(`call: could not answer (${errText(err)})`);
      if (this.call === c) this.end(c, 'failed');
    }
  }

  private collision(active: Call, env: CallEnvelope, incomingId: bigint): 'busy' | 'winner' | 'loser' | 'doubleLoser' | 'recall' {
    const tiebreak = () => (active.id > incomingId ? 'winner' : active.id < incomingId ? 'loser' : 'doubleLoser');
    if (active.peer !== env.source) return 'busy';
    if (active.activeDevice === null) return tiebreak();
    if (active.activeDevice !== env.sourceDevice) return 'busy';
    return active.accepted && active.phase === 'connected' ? 'recall' : tiebreak();
  }

  private onAnswer(env: CallEnvelope, id: bigint, opaque: Uint8Array): void {
    const c = this.call;
    if (!c || c.id !== id || c.direction !== 'outgoing' || c.peer !== env.source || c.phase === 'ended') return;
    const existing = c.legs.get(env.sourceDevice);
    if (c.accepted || (existing && existing.conn)) return;
    const remote = parseParams(opaque, 'answer');
    if (!remote) {
      this.deps.log('call: dropped an answer without usable V4 parameters');
      return;
    }
    c.legs.set(env.sourceDevice, { deviceId: env.sourceDevice, conn: null, ice: null, pendingIce: existing ? existing.pendingIce : [], failed: false });
    try {
      this.connectLeg(c, env.sourceDevice, remote);
    } catch (err) {
      this.deps.log(`call: could not use an answer (${errText(err)})`);
    }
  }

  private onIce(env: CallEnvelope, updates: { id: bigint; opaque: Uint8Array }[]): void {
    const c = this.call;
    if (!c || c.peer !== env.source || c.phase === 'ended') return;
    if (c.direction === 'incoming' && c.activeDevice !== env.sourceDevice) return;
    let leg = c.legs.get(env.sourceDevice);
    if (!leg) {
      if (c.direction !== 'outgoing' || c.accepted) return;
      leg = { deviceId: env.sourceDevice, conn: null, ice: null, pendingIce: [], failed: false };
      c.legs.set(env.sourceDevice, leg);
    }
    for (const u of updates) {
      if (u.id !== c.id) continue;
      if (leg.ice) this.applyIce(c, leg.ice, u.opaque);
      else if (leg.pendingIce.length < MAX_PENDING_ICE) leg.pendingIce.push(u.opaque);
    }
  }

  private onBusy(env: CallEnvelope, id: bigint): void {
    const c = this.call;
    if (!c || c.id !== id || c.direction !== 'outgoing' || c.peer !== env.source || c.accepted || c.phase === 'ended') return;
    this.hangupAll(c, CallMessage_Hangup_Type.HANGUP_BUSY, env.sourceDevice, env.sourceDevice);
    this.end(c, 'busy');
  }

  private onHangup(env: CallEnvelope, id: bigint, type: CallMessage_Hangup_Type, deviceId: number): void {
    const c = this.call;
    if (!c || c.id !== id || c.peer !== env.source || c.phase === 'ended') return;
    this.remoteHangup(c, env.sourceDevice, type, deviceId);
  }

  private remoteHangup(c: Call, from: number, type: CallMessage_Hangup_Type, deviceId: number): void {
    if (c.direction === 'incoming') {
      if (from !== c.activeDevice) return;
      if (type !== CallMessage_Hangup_Type.HANGUP_NORMAL && deviceId === this.ourDevice) return;
      const reason: CallEndReason =
        type === CallMessage_Hangup_Type.HANGUP_ACCEPTED
          ? 'acceptedElsewhere'
          : type === CallMessage_Hangup_Type.HANGUP_DECLINED
            ? 'declinedElsewhere'
            : type === CallMessage_Hangup_Type.HANGUP_BUSY
              ? 'busyElsewhere'
              : c.accepted
                ? 'remoteHungUp'
                : 'missed';
      this.end(c, reason);
      return;
    }
    if (c.accepted) {
      if (from === c.activeDevice) this.end(c, 'remoteHungUp');
      return;
    }
    if (type === CallMessage_Hangup_Type.HANGUP_NORMAL) {
      this.hangupAll(c, CallMessage_Hangup_Type.HANGUP_DECLINED, from, from);
      this.end(c, 'remoteDeclined');
    } else if (type === CallMessage_Hangup_Type.HANGUP_NEED_PERMISSION) {
      this.hangupAll(c, CallMessage_Hangup_Type.HANGUP_NEED_PERMISSION, from, from);
      this.end(c, 'needPermission');
    }
  }

  private onTimeout(c: Call): void {
    if (this.call !== c || c.accepted || c.phase === 'ended') return;
    if (c.direction === 'outgoing') {
      if (c.offerSent) this.hangupAll(c, CallMessage_Hangup_Type.HANGUP_NORMAL, 0);
      this.end(c, 'noAnswer');
    } else {
      // Unlike RingRTC, no hangup here: an offer that arrived late would otherwise stop the caller's other devices still ringing.
      this.end(c, 'missed');
    }
  }

  private async openMedia(c: Call): Promise<void> {
    c.turn = await this.deps.openRelay();
    if (this.call !== c || c.phase === 'ended') {
      c.turn.close();
      return;
    }
    c.mux = new RelayMux(c.turn);
    c.turn.onClosed = () => {
      if (this.call === c && c.phase !== 'ended') {
        this.deps.log('call: relay connection closed');
        if (c.accepted) this.hangupAll(c, CallMessage_Hangup_Type.HANGUP_NORMAL, 0);
        this.end(c, 'failed');
      }
    };
    c.keys = this.deps.newKeys();
    c.audio = this.deps.newAudio();
    c.audio.onPacket = (opus, samples, skipped) => {
      const leg = this.activeLeg(c);
      if (!leg || !leg.conn) return;
      if (skipped) leg.conn.skipAudio(skipped);
      leg.conn.sendAudio(opus, samples);
    };
  }

  private connectLeg(c: Call, deviceId: number, remote: ConnectionParametersV4): void {
    if (!c.turn || !c.mux || !c.keys || !c.identity) throw new Error('media not ready');
    const leg = c.legs.get(deviceId)!;
    const weAreCaller = c.direction === 'outgoing';
    const callerId = weAreCaller ? c.identity.ours : c.identity.theirs;
    const calleeId = weAreCaller ? c.identity.theirs : c.identity.ours;
    const srtp = c.keys.srtp(remote.publicKey, callerId, calleeId, weAreCaller);
    const ice = new IceAgent({ turn: c.turn, controlling: weAreCaller, localUfrag: c.ufrag, localPwd: c.pwd, now: this.now });
    ice.setRemoteCredentials(remote.iceUfrag, remote.icePwd);
    c.mux.add(ice);
    const conn = new CallConnection(c.id, deviceId, weAreCaller, ice, srtp, {
      connected: () => this.onLegConnected(c),
      failed: (reason) => this.onLegFailed(c, leg, reason),
      accepted: () => this.onRemoteAccepted(c, leg),
      hangup: (id, type, devId) => {
        if (id === c.id && this.call === c && c.phase !== 'ended') this.remoteHangup(c, deviceId, type as number as CallMessage_Hangup_Type, devId);
      },
      remoteAudio: (enabled) => {
        if (this.activeLeg(c) === leg && c.remoteMuted === enabled) {
          c.remoteMuted = !enabled;
          this.emit();
        }
      },
      audio: (seq, ts, payload) => {
        if (c.audio && this.activeLeg(c) === leg) c.audio.receive(seq, ts, payload);
      },
    });
    leg.ice = ice;
    leg.conn = conn;
    if (c.accepted && c.direction === 'incoming') {
      conn.sendAccepted();
      conn.setSendingAudio(true);
    }
    ice.start();
    for (const opaque of leg.pendingIce) this.applyIce(c, ice, opaque);
    leg.pendingIce = [];
  }

  private applyIce(c: Call, ice: IceAgent, opaque: Uint8Array): void {
    let cand;
    try {
      cand = fromBinary(IceCandidateSchema, opaque);
    } catch {
      return;
    }
    const relayed = c.turn && c.turn.relayed;
    if (cand.addedV3) {
      const parsed = parseCandidate(cand.addedV3.sdp);
      // Our relay allocation is IPv4; an IPv6 peer address can't be permitted on it.
      if (parsed && relayed && parsed.address.ip.includes(':') === relayed.ip.includes(':')) ice.addRemoteCandidate(parsed);
    } else if (cand.removed && cand.removed.ip.length) {
      const ip = ipFromBytes(cand.removed.ip);
      if (ip) ice.removeRemoteAddress({ ip, port: cand.removed.port });
    }
  }

  private onLegConnected(c: Call): void {
    if (this.call !== c || c.phase === 'ended') return;
    if (c.direction === 'outgoing') {
      if (c.phase === 'outgoing') {
        c.phase = 'ringing';
        this.emit();
      }
      return;
    }
    if (c.accepted && c.phase === 'connecting') {
      c.phase = 'connected';
      c.connectedAt = this.now();
      this.emit();
    }
  }

  private onLegFailed(c: Call, leg: Leg, reason: string): void {
    if (this.call !== c || c.phase === 'ended') return;
    this.deps.log(`call: connection to device ${leg.deviceId} failed (${reason})`);
    leg.failed = true;
    const active = this.activeLeg(c);
    if (c.direction === 'incoming' || active === leg) {
      if (c.accepted) this.hangupAll(c, CallMessage_Hangup_Type.HANGUP_NORMAL, 0);
      this.end(c, 'failed');
      return;
    }
    this.closeLeg(c, leg);
  }

  private onRemoteAccepted(c: Call, leg: Leg): void {
    if (this.call !== c || c.direction !== 'outgoing' || c.accepted || c.phase === 'ended' || !leg.conn) return;
    c.accepted = true;
    c.activeDevice = leg.deviceId;
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    leg.conn.setSendingAudio(true);
    if (c.muted) leg.conn.sendAudioEnabled(false);
    for (const other of c.legs.values()) {
      if (other === leg) continue;
      if (other.conn) other.conn.sendHangup(RtpHangupType.HANGUP_ACCEPTED, leg.deviceId);
    }
    this.signalHangup(c, CallMessage_Hangup_Type.HANGUP_ACCEPTED, leg.deviceId);
    // Let the RTP data hangup go out before the other legs close.
    setTimeout(() => {
      for (const other of c.legs.values()) if (other !== leg) this.closeLeg(c, other);
    }, 1000);
    c.phase = 'connected';
    c.connectedAt = this.now();
    this.emit();
  }

  private activeLeg(c: Call): Leg | null {
    return c.activeDevice === null ? null : c.legs.get(c.activeDevice) || null;
  }

  /** Sends a hangup over RTP data on each live leg except the device it is about, and over signaling. */
  private hangupAll(c: Call, type: CallMessage_Hangup_Type, deviceId: number, except = -1): void {
    for (const leg of c.legs.values()) {
      if (leg.deviceId !== except && leg.conn) leg.conn.sendHangup(type as number as RtpHangupType, deviceId);
    }
    this.signalHangup(c, type, deviceId);
  }

  private signalHangup(c: Call, type: CallMessage_Hangup_Type, deviceId: number): void {
    const hangup = create(CallMessage_HangupSchema, { id: c.id, type, deviceId });
    if (c.direction === 'incoming') {
      if (c.activeDevice !== null) this.sendTo(c.peer, c.activeDevice, { hangup });
      return;
    }
    // RingRTC sends the caller's hangups to every callee device; a device skips one that names itself.
    this.deps.send(c.peer, create(CallMessageSchema, { hangup }), false).catch((err) => this.deps.log(`call: hangup not sent (${errText(err)})`));
  }

  private sendTo(peer: string, deviceId: number, fields: Partial<Pick<CallMessage, 'busy' | 'hangup'>>): void {
    this.deps.send(peer, create(CallMessageSchema, { ...fields, destinationDeviceId: deviceId }), false).catch((err) => this.deps.log(`call: message not sent (${errText(err)})`));
  }

  private sendIce(c: Call, deviceId: number): void {
    if (!c.turn || !c.turn.relayed) return;
    const sdp = relayCandidateSdp(c.turn.relayed, c.ufrag);
    const opaque = toBinary(IceCandidateSchema, create(IceCandidateSchema, { addedV3: create(IceCandidateV3Schema, { sdp }) }));
    const msg = create(CallMessageSchema, { iceUpdate: [create(CallMessage_IceUpdateSchema, { id: c.id, opaque })], destinationDeviceId: deviceId || 0 });
    this.deps.send(c.peer, msg, false).catch((err) => this.deps.log(`call: ICE update not sent (${errText(err)})`));
  }

  private localParams(c: Call): ConnectionParametersV4 {
    // RingRTC rejects parameters without video codecs even for audio calls.
    const vp8 = () => [create(VideoCodecSchema, { type: VideoCodecType.VP8 })];
    return create(ConnectionParametersV4Schema, {
      publicKey: c.keys!.publicKey(),
      iceUfrag: c.ufrag,
      icePwd: c.pwd,
      maxBitrateBps: MAX_BITRATE_BPS,
      encodeOnlyVideoCodecs: vp8(),
      decodeOnlyVideoCodecs: vp8(),
    });
  }

  private closeLeg(c: Call, leg: Leg): void {
    if (leg.conn) leg.conn.close();
    if (leg.ice && c.mux) c.mux.remove(leg.ice);
    leg.conn = null;
    leg.ice = null;
  }

  private end(c: Call, reason: CallEndReason): void {
    if (c.phase === 'ended') return;
    const connected = c.connectedAt !== null;
    c.phase = 'ended';
    c.endReason = reason;
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    // Give the last RTP data hangup a moment to leave before the relay goes.
    const legs = [...c.legs.values()];
    setTimeout(() => {
      for (const leg of legs) this.closeLeg(c, leg);
      if (c.turn) c.turn.close();
      if (c.keys && c.keys.free) c.keys.free();
      c.keys = null;
    }, 500);
    if (c.audio) c.audio.close();
    const outcome: CallRecord['outcome'] =
      connected || c.accepted || reason === 'acceptedElsewhere'
        ? 'accepted'
        : reason === 'declined' || reason === 'declinedElsewhere'
          ? 'declined'
          : c.direction === 'incoming'
            ? 'missed'
            : 'unanswered';
    if (!(c.direction === 'outgoing' && !c.offerSent)) this.deps.record(this.recordFor(c, outcome));
    this.emit();
  }

  private recordFor(c: Call, outcome: CallRecord['outcome']): CallRecord {
    return {
      callId: c.id.toString(),
      peer: c.peer,
      direction: c.direction,
      outcome,
      timestamp: c.startedAt,
      durationMs: c.connectedAt ? this.now() - c.connectedAt : 0,
    };
  }

  /** The call's legs, ICE pairs, and packet counts, without addresses or keys, for the debug log. */
  debug(): string {
    const c = this.call;
    if (!c) return 'no call';
    const legs = [...c.legs.values()].map((l) => {
      const s = l.conn ? l.conn.stats : null;
      return `device ${l.deviceId}${l.failed ? ' failed' : ''}: ${l.ice ? l.ice.summary() : 'no ICE'}${s ? `, sent ${s.sent} received ${s.received} undecryptable ${s.decryptFailures}` : ''}${l.pendingIce.length ? `, ${l.pendingIce.length} ICE updates waiting` : ''}`;
    });
    return `${c.direction} ${c.phase}${c.accepted ? ' accepted' : ''}, active device ${c.activeDevice === null ? 'none' : c.activeDevice}, relay ${c.turn ? 'open' : 'none'}, opus complexity ${c.audio ? c.audio.complexity : '-'}; ${legs.join('; ') || 'no legs'}`;
  }

  private snapshot(c: Call): CallState {
    return {
      callId: c.id.toString(),
      peer: c.peer,
      direction: c.direction,
      phase: c.phase,
      muted: c.muted,
      remoteMuted: c.remoteMuted,
      startedAt: c.startedAt,
      connectedAt: c.connectedAt,
      endReason: c.endReason,
    };
  }

  private emit(): void {
    const s = this.state;
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch {
        // a broken listener must not stop the call
      }
    }
  }
}

function parseParams(opaque: Uint8Array, kind: 'offer' | 'answer'): ConnectionParametersV4 | null {
  try {
    const v4 = kind === 'offer' ? fromBinary(OfferSchema, opaque).v4 : fromBinary(AnswerSchema, opaque).v4;
    if (!v4 || v4.publicKey.length !== 32) return null;
    if (!v4.iceUfrag || !v4.icePwd || v4.iceUfrag.length > 256 || v4.icePwd.length > 256) return null;
    return v4;
  } catch {
    return null;
  }
}

function newCallId(): bigint {
  const b = crypto.getRandomValues(new Uint8Array(8));
  const id = new DataView(b.buffer).getBigUint64(0);
  return id || 1n;
}

function ipFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length === 4) return Array.from(bytes).join('.');
  if (bytes.length !== 16) return null;
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  const ip = parts.join(':');
  return parseIp(ip) ? ip : null;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
