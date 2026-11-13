/* Call audio between the app's microphone and speaker and the network: 60 ms Opus frames out (RingRTC's packet size), and a jitter buffer that plays what arrives. */

import { JitterBuffer, OPUS_CLOCK, type Decoder } from './rtp';

export interface Encoder {
  encode(pcm: Float32Array): Uint8Array;
  setComplexity?(complexity: number): void;
  free?(): void;
}

export interface FreeableDecoder extends Decoder {
  free?(): void;
}

/** The rate the app captures and plays at; Opus handles any of its rates internally. */
export const CALL_SAMPLE_RATE = 16000;
export const FRAME_MS = 60;
/** RingRTC runs Opus at 32 kbps CBR; the same rate keeps the peer's bandwidth estimate steady. */
export const OPUS_BITRATE = 32000;
/** Lower than RingRTC's 9: encoding runs on the main thread without wasm SIMD, and paced 60 ms frames take about 17 ms each on the T440W at 3 (12 ms at 1). */
export const OPUS_COMPLEXITY = 3;
/** Steps taken when encoding uses more than `ENCODE_BUDGET` of each frame's time, for slower phones. */
export const COMPLEXITY_STEPS = [OPUS_COMPLEXITY, 1, 0];
export const ENCODE_BUDGET = 0.5;
/** Frames averaged before judging the encoder's speed at a complexity. */
const ENCODE_SAMPLE = 25;

const cpuClock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class CallAudio {
  /** Each encoded packet, the 48 kHz clock it covers, and the clock skipped before it by muting or DTX. */
  onPacket: ((opus: Uint8Array, samples48k: number, skipped48k: number) => void) | null = null;
  muted = false;

  private readonly frame = (CALL_SAMPLE_RATE * FRAME_MS) / 1000;
  private pending = new Float32Array(this.frame);
  private filled = 0;
  private skipped = 0;
  private readonly jitter: JitterBuffer;
  private closed = false;
  private step = 0;
  private encodeMs = 0;
  private encoded = 0;

  constructor(
    private readonly encoder: Encoder,
    private readonly decoder: FreeableDecoder,
    private readonly clock: () => number = cpuClock
  ) {
    this.jitter = new JitterBuffer(decoder, CALL_SAMPLE_RATE);
  }

  /** The encoder's complexity now, after any steps down. */
  get complexity(): number {
    return COMPLEXITY_STEPS[this.step];
  }

  /** Microphone samples at `CALL_SAMPLE_RATE`, in any chunk size. */
  capture(pcm: Float32Array): void {
    if (this.closed) return;
    let off = 0;
    while (off < pcm.length) {
      const n = Math.min(pcm.length - off, this.frame - this.filled);
      this.pending.set(pcm.subarray(off, off + n), this.filled);
      this.filled += n;
      off += n;
      if (this.filled === this.frame) {
        this.filled = 0;
        this.encodeFrame();
      }
    }
  }

  private encodeFrame(): void {
    const frame48k = (this.frame * OPUS_CLOCK) / CALL_SAMPLE_RATE;
    if (this.muted) {
      this.skipped += frame48k;
      return;
    }
    let packet: Uint8Array;
    const started = this.clock();
    try {
      packet = this.encoder.encode(this.pending);
    } catch {
      this.skipped += frame48k;
      return;
    }
    this.pace(this.clock() - started);
    // Opus DTX returns a 1 or 2 byte packet for frames that needn't be sent; it emits a comfort noise update on its own every 400 ms.
    if (packet.length <= 2) {
      this.skipped += frame48k;
      return;
    }
    const skipped = this.skipped;
    this.skipped = 0;
    if (this.onPacket) this.onPacket(packet, frame48k, skipped);
  }

  private pace(ms: number): void {
    if (!this.encoder.setComplexity || this.step >= COMPLEXITY_STEPS.length - 1) return;
    this.encodeMs += ms;
    if (++this.encoded < ENCODE_SAMPLE) return;
    const slow = this.encodeMs / this.encoded > FRAME_MS * ENCODE_BUDGET;
    this.encodeMs = 0;
    this.encoded = 0;
    if (!slow) return;
    try {
      this.encoder.setComplexity(COMPLEXITY_STEPS[this.step + 1]);
      this.step++;
    } catch {
      // stays at the current complexity
    }
  }

  receive(seq: number, timestamp: number, payload: Uint8Array): void {
    if (!this.closed) this.jitter.push(seq, timestamp, payload);
  }

  /** The next stretch of the peer's audio, or null until its next packet arrives. */
  pull(): Float32Array | null {
    if (this.closed) return null;
    try {
      return this.jitter.pull();
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.encoder.free) this.encoder.free();
    if (this.decoder.free) this.decoder.free();
  }
}
