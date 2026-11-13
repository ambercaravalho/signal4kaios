/* RTP for a RingRTC 1:1 call: Opus audio and RingRTC's "RTP data" control messages, with the payload types and SSRCs RingRTC's V4 session descriptions fix. */

export const OPUS_PT = 102;
export const RTP_DATA_PT = 101;
/** RingRTC `connection.rs` RTP_DATA_SSRC, the same in both directions. */
export const RTP_DATA_SSRC = 0xd;
/** RingRTC `Rust_sessionDescriptionFromV4`: the caller's SSRCs are 1XXX and the callee's 2XXX; audio is base + 2. */
export const audioSsrc = (caller: boolean) => (caller ? 1002 : 2002);
/** Opus always uses a 48 kHz RTP clock (RFC 7587). */
export const OPUS_CLOCK = 48000;

export interface RtpPacket {
  marker: boolean;
  payloadType: number;
  seq: number;
  timestamp: number;
  ssrc: number;
  payload: Uint8Array;
}

export function buildRtp(p: Omit<RtpPacket, 'payload'>, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const v = new DataView(out.buffer);
  out[0] = 0x80;
  out[1] = (p.marker ? 0x80 : 0) | (p.payloadType & 0x7f);
  v.setUint16(2, p.seq & 0xffff);
  v.setUint32(4, p.timestamp >>> 0);
  v.setUint32(8, p.ssrc >>> 0);
  out.set(payload, 12);
  return out;
}

/** Parses a decrypted RTP packet, skipping CSRCs, header extensions, and padding. Null for anything malformed. */
export function parseRtp(b: Uint8Array): RtpPacket | null {
  if (b.length < 12 || b[0] >> 6 !== 2) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12 + 4 * (b[0] & 0x0f);
  if (b[0] & 0x10) {
    if (b.length < off + 4) return null;
    off += 4 + 4 * v.getUint16(off + 2);
  }
  let end = b.length;
  if (b[0] & 0x20) {
    const pad = b[b.length - 1];
    if (!pad || pad > end - off) return null;
    end -= pad;
  }
  if (off > end) return null;
  return { marker: (b[1] & 0x80) !== 0, payloadType: b[1] & 0x7f, seq: v.getUint16(2), timestamp: v.getUint32(4), ssrc: v.getUint32(8), payload: b.subarray(off, end) };
}

/** RTCP packet types are 192 to 223 in the second byte (RFC 5761 section 4), which no RTP payload type of this call collides with. */
export function isRtcp(b: Uint8Array): boolean {
  return b.length >= 8 && b[0] >> 6 === 2 && b[1] >= 192 && b[1] <= 223;
}

/** 16-bit sequence comparison: positive when `a` is after `b`. */
export function seqDiff(a: number, b: number): number {
  return ((a - b + 0x8000) & 0xffff) - 0x8000;
}

interface Queued {
  seq: number;
  timestamp: number;
  payload: Uint8Array;
}

export interface Decoder {
  decode(packet: Uint8Array, frameSamples: number, fec: boolean): Float32Array;
}

/**
 * The peer's packets in sequence order, decoded as playback asks for them; the app's player does the buffering, so this never makes up audio to fill time. A missing packet is rebuilt from the next one's in-band FEC, or concealed, once a second packet behind it shows it isn't just reordered; a timestamp gap with no missing sequence number is Opus DTX silence, filled with the decoder's comfort noise.
 */
export class JitterBuffer {
  private queue: Queued[] = [];
  private nextSeq = -1;
  private nextTs = 0;

  constructor(
    private readonly decoder: Decoder,
    private readonly sampleRate: number,
    /** Older audio beyond this much queued is dropped, as after a burst. */
    private readonly maxMs = 300
  ) {}

  private queuedMs(): number {
    if (!this.queue.length) return 0;
    const from = this.nextSeq < 0 ? this.queue[0].timestamp : this.nextTs;
    return (((this.queue[this.queue.length - 1].timestamp - from) >>> 0) / OPUS_CLOCK) * 1000 + 60;
  }

  push(seq: number, timestamp: number, payload: Uint8Array): void {
    if (this.nextSeq >= 0 && seqDiff(seq, this.nextSeq) < 0) return;
    let i = this.queue.length;
    while (i > 0 && seqDiff(this.queue[i - 1].seq, seq) > 0) i--;
    if (i > 0 && this.queue[i - 1].seq === seq) return;
    this.queue.splice(i, 0, { seq, timestamp, payload });
    if (this.queue.length > 64) this.queue.shift();
  }

  /** The next stretch of audio at `sampleRate`, or null when the next packet hasn't arrived. */
  pull(): Float32Array | null {
    const frame60 = (this.sampleRate * 60) / 1000;
    if (this.nextSeq < 0) {
      if (!this.queue.length) return null;
      this.nextSeq = this.queue[0].seq;
      this.nextTs = this.queue[0].timestamp;
    }
    while (this.queue.length > 1 && this.queuedMs() > this.maxMs) {
      const dropped = this.queue.shift()!;
      this.nextSeq = (dropped.seq + 1) & 0xffff;
      this.nextTs = this.queue[0].timestamp;
    }
    const head = this.queue[0];
    if (!head) return null;
    const gap = (head.timestamp - this.nextTs) | 0;
    const gapSamples = gap > 0 && gap < OPUS_CLOCK ? Math.min(Math.round((gap / OPUS_CLOCK) * this.sampleRate), frame60) : 0;
    if (head.seq === this.nextSeq) {
      if (gapSamples) return this.advanceTs(this.decoder.decode(new Uint8Array(0), gapSamples, false));
      this.queue.shift();
      const pcm = this.decoder.decode(head.payload, frame60, false);
      this.nextSeq = (head.seq + 1) & 0xffff;
      this.nextTs = (head.timestamp + Math.round((pcm.length / this.sampleRate) * OPUS_CLOCK)) >>> 0;
      return pcm;
    }
    if (this.queue.length < 2) return null;
    const samples = gapSamples || frame60;
    const pcm = seqDiff(head.seq, this.nextSeq) === 1 ? this.decoder.decode(head.payload, samples, true) : this.decoder.decode(new Uint8Array(0), samples, false);
    this.nextSeq = (this.nextSeq + 1) & 0xffff;
    return this.advanceTs(pcm);
  }

  private advanceTs(pcm: Float32Array): Float32Array {
    this.nextTs = (this.nextTs + Math.round((pcm.length / this.sampleRate) * OPUS_CLOCK)) >>> 0;
    return pcm;
  }
}
