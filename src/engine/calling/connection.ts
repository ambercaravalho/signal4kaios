/* One call leg with one of the peer's devices: ICE through our TURN relay, SRTP, Opus audio, and RingRTC's RTP data messages (accepted, hangup, sender status), resent every second like RingRTC's Connection::tick. */

import { isFieldSet } from '@bufbuild/protobuf';

import { create, fromBinary, toBinary } from '../net/proto';
import {
  AcceptedSchema,
  HangupSchema,
  type Hangup_Type,
  type Message as RtpDataMessage,
  MessageSchema as RtpDataMessageSchema,
  SenderStatusSchema,
} from '../gen/rtp_data_pb';
import { IceAgent } from './ice';
import { audioSsrc, buildRtp, isRtcp, OPUS_CLOCK, OPUS_PT, parseRtp, RTP_DATA_PT, RTP_DATA_SSRC } from './rtp';

/** The SRTP contexts from `libsignal.CallKeyPair.srtp`, or a stand-in in tests. */
export interface Srtp {
  protectRtp(packet: Uint8Array): Uint8Array;
  unprotectRtp(packet: Uint8Array): Uint8Array;
  free?(): void;
}

const RTP_DATA_INTERVAL_MS = 1000;
/** RingRTC `connection.rs` rejects RTP data messages larger than twice its in-memory size; ours never come close. */
const MAX_RTP_DATA_BYTES = 512;

export interface ConnectionEvents {
  connected(): void;
  failed(reason: string): void;
  accepted(callId: bigint): void;
  hangup(callId: bigint, type: Hangup_Type, deviceId: number): void;
  remoteAudio(enabled: boolean): void;
  audio(seq: number, timestamp: number, payload: Uint8Array): void;
}

export class CallConnection {
  private data: RtpDataMessage = create(RtpDataMessageSchema, {});
  private dataSeq = 0;
  private dataTimer: ReturnType<typeof setInterval> | null = null;
  private lastRemoteDataTs = 0;
  private audioSeq = Math.floor(Math.random() * 0x8000);
  private audioTs = Math.floor(Math.random() * 0x7fffffff);
  private sendingAudio = false;
  private lastAudioAt = 0;
  private closed = false;
  stats = { sent: 0, received: 0, decryptFailures: 0 };

  constructor(
    readonly callId: bigint,
    readonly remoteDeviceId: number,
    private readonly weAreCaller: boolean,
    readonly ice: IceAgent,
    private readonly srtp: Srtp,
    private readonly events: ConnectionEvents
  ) {
    ice.onPacket = (pkt) => this.onPacket(pkt);
    ice.onConnected = () => {
      this.sendData();
      events.connected();
    };
    ice.onFailed = (reason) => events.failed(reason);
    this.dataTimer = setInterval(() => this.sendData(), RTP_DATA_INTERVAL_MS);
  }

  /** Our audio starts flowing only after the call is accepted, as RingRTC does. */
  setSendingAudio(on: boolean): void {
    this.sendingAudio = on;
  }

  sendAccepted(): void {
    this.data.accepted = create(AcceptedSchema, { id: this.callId });
    this.sendData();
  }

  sendHangup(type: Hangup_Type, deviceId: number): void {
    this.data.hangup = create(HangupSchema, { id: this.callId, type, deviceId });
    this.sendData();
  }

  sendAudioEnabled(enabled: boolean): void {
    this.data.senderStatus = create(SenderStatusSchema, { id: this.callId, audioEnabled: enabled, videoEnabled: false, sharingScreen: false });
    this.sendData();
  }

  /** Sends one Opus packet covering `samples48k` of the 48 kHz RTP clock. */
  sendAudio(opus: Uint8Array, samples48k: number): void {
    if (!this.sendingAudio || this.closed || !this.ice.connected) return;
    const now = Date.now();
    const marker = now - this.lastAudioAt > 200;
    this.lastAudioAt = now;
    const packet = buildRtp({ marker, payloadType: OPUS_PT, seq: this.audioSeq, timestamp: this.audioTs, ssrc: audioSsrc(this.weAreCaller) }, opus);
    this.audioSeq = (this.audioSeq + 1) & 0xffff;
    this.audioTs = (this.audioTs + samples48k) >>> 0;
    this.sendSrtp(packet);
  }

  /** Advances the audio clock over a stretch Opus DTX left out. */
  skipAudio(samples48k: number): void {
    this.audioTs = (this.audioTs + samples48k) >>> 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.dataTimer) clearInterval(this.dataTimer);
    this.ice.close();
    if (this.srtp.free) this.srtp.free();
  }

  private sendData(): void {
    if (this.closed || !this.ice.connected) return;
    const d = this.data;
    if (!d.accepted && !d.hangup && !d.senderStatus) return;
    this.dataSeq++;
    d.seqnum = BigInt(this.dataSeq);
    const packet = buildRtp({ marker: false, payloadType: RTP_DATA_PT, seq: this.dataSeq, timestamp: this.dataSeq, ssrc: RTP_DATA_SSRC }, toBinary(RtpDataMessageSchema, d));
    this.sendSrtp(packet);
  }

  private sendSrtp(packet: Uint8Array): void {
    try {
      this.ice.send(this.srtp.protectRtp(packet));
      this.stats.sent++;
    } catch {
      // A packet that can't be protected is dropped; RTP tolerates loss.
    }
  }

  private onPacket(pkt: Uint8Array): void {
    if (this.closed || isRtcp(pkt)) return;
    let plain: Uint8Array;
    try {
      plain = this.srtp.unprotectRtp(pkt);
    } catch {
      this.stats.decryptFailures++;
      return;
    }
    const rtp = parseRtp(plain);
    if (!rtp) return;
    this.stats.received++;
    if (rtp.payloadType === OPUS_PT) {
      this.events.audio(rtp.seq, rtp.timestamp, rtp.payload);
      return;
    }
    if (rtp.payloadType !== RTP_DATA_PT || rtp.ssrc !== RTP_DATA_SSRC || rtp.payload.length > MAX_RTP_DATA_BYTES) return;
    // RingRTC allows equal timestamps from older clients that sent several messages per tick.
    if (rtp.timestamp < this.lastRemoteDataTs) return;
    this.lastRemoteDataTs = rtp.timestamp;
    let msg: RtpDataMessage;
    try {
      msg = fromBinary(RtpDataMessageSchema, rtp.payload);
    } catch {
      return;
    }
    if (msg.accepted && msg.accepted.id === this.callId && this.weAreCaller) this.events.accepted(this.callId);
    if (msg.hangup) this.events.hangup(msg.hangup.id, msg.hangup.type, msg.hangup.deviceId);
    if (msg.senderStatus && isFieldSet(msg.senderStatus, SenderStatusSchema.field.audioEnabled)) this.events.remoteAudio(msg.senderStatus.audioEnabled);
  }
}

export const opusSamples48k = (samples: number, rate: number) => Math.round((samples * OPUS_CLOCK) / rate);
