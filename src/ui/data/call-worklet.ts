/* The call's audio thread: microphone samples down to 16 kHz in 20 ms chunks for the app, and the peer's 16 kHz audio up to the device rate for the speaker. One node can do either or both (`processorOptions` `capture` and `play`), since the earpiece's telephony channel can't share a context with the microphone. Built on its own into `build/call-worklet.js`, as a worklet module loads by URL. */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;
declare const sampleRate: number;

const RATE = 16000;
const CHUNK = 320;
/** Playback beyond this is dropped, so a stall on the app's side can't grow the delay for the rest of the call. */
const MAX_QUEUED = RATE / 2;

interface Options {
  processorOptions?: { capture?: boolean; play?: boolean };
}

/** Playback progress as running totals, so a report that arrives late still adds up: 16 kHz samples played from the queue, the times the queue ran dry, and samples dropped for overflow. */
export interface PlayReport {
  played: number;
  starved: number;
  dropped: number;
}

class CallIO extends AudioWorkletProcessor {
  // Resampling phases count in whole units of RATE against sampleRate: a fractional step (1/3 at 48 kHz) drifts and makes one side run a few percent off 16 kHz.
  private readonly capturing: boolean;
  private readonly playing: boolean;
  private capPos = 0;
  private capAcc = 0;
  private capCount = 0;
  private chunk = new Float32Array(CHUNK);
  private filled = 0;
  private queue: Float32Array[] = [];
  private queued = 0;
  private head: Float32Array | null = null;
  private headAt = 0;
  private playPos = 0;
  private sinceReport = 0;
  private played = 0;
  private starved = 0;
  private dropped = 0;
  private prime = 1600;
  private priming = true;
  private last = 0;
  private next = 0;
  private stopped = false;

  constructor(options: Options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.capturing = o.capture !== false;
    this.playing = o.play !== false;
    this.port.onmessage = (e: MessageEvent) => {
      const d = e.data;
      if (d === 'stop') {
        this.stopped = true;
        return;
      }
      if (d && typeof d.prime === 'number') {
        this.prime = Math.max(0, Math.min(MAX_QUEUED, d.prime));
        return;
      }
      if (!this.playing || !(d instanceof Float32Array) || !d.length) return;
      this.queue.push(d);
      this.queued += d.length;
      while (this.queued > MAX_QUEUED && this.queue.length > 1) {
        const n = this.queue.shift()!.length;
        this.queued -= n;
        this.dropped += n;
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    if (this.capturing) {
      const input = inputs[0] && inputs[0][0];
      this.capture(input || new Float32Array(128));
    }
    const out = outputs[0];
    if (this.playing && out && out[0]) {
      this.play(out[0]);
      for (let c = 1; c < out.length; c++) out[c].set(out[0]);
      // A playback-only node reports itself, every 20 ms of output.
      if (!this.capturing && this.sinceReport >= CHUNK) {
        this.sinceReport -= CHUNK;
        this.port.postMessage(this.report());
      }
    }
    return true;
  }

  private report(): PlayReport {
    return { played: this.played, starved: this.starved, dropped: this.dropped };
  }

  /** Averages the input over each 16 kHz sample period. */
  private capture(input: Float32Array): void {
    for (let i = 0; i < input.length; i++) {
      this.capAcc += input[i];
      this.capCount++;
      this.capPos += RATE;
      if (this.capPos < sampleRate) continue;
      this.capPos -= sampleRate;
      this.chunk[this.filled++] = this.capAcc / this.capCount;
      this.capAcc = 0;
      this.capCount = 0;
      if (this.filled === CHUNK) {
        const msg = this.playing ? { pcm: this.chunk, ...this.report() } : { pcm: this.chunk };
        this.port.postMessage(msg, [this.chunk.buffer]);
        this.chunk = new Float32Array(CHUNK);
        this.filled = 0;
      }
    }
  }

  /** Linear interpolation between 16 kHz samples; silence when nothing is queued. */
  private play(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      out[i] = this.last + ((this.next - this.last) * this.playPos) / sampleRate;
      this.playPos += RATE;
      while (this.playPos >= sampleRate) {
        this.playPos -= sampleRate;
        this.last = this.next;
        this.next = this.take();
        this.sinceReport++;
      }
    }
  }

  /** The next queued sample. Playback waits until `prime` samples are queued, at the start and again after running dry, so it resumes with a cushion instead of stuttering packet to packet. */
  private take(): number {
    if (this.priming) {
      if (this.queued < this.prime || !this.queued) return 0;
      this.priming = false;
    }
    if (!this.head || this.headAt >= this.head.length) {
      if (this.head) this.queued -= this.head.length;
      this.head = this.queue.shift() || null;
      this.headAt = 0;
      if (!this.head) {
        this.starved++;
        this.priming = true;
        return 0;
      }
    }
    this.played++;
    return this.head[this.headAt++];
  }
}

registerProcessor('call-io', CallIO);
