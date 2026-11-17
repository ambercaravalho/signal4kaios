/* Records a voice message as MP3 with a waveform and length, as Signal-Desktop sends them (Gecko's MediaRecorder only makes Ogg Opus, which not every Signal app plays). The microphone comes through the call worklet as 16 kHz mono and is encoded as it arrives, so a long recording never sits in memory as raw audio. */

import { Mp3Encoder } from '@breezystack/lamejs';
import { readDataUri } from './attachments';
import { WORKLET_URL } from './call-audio';
import type { OutgoingFile } from './store';

const VOICE_RATE = 16000;
const MAX_VOICE_MS = 15 * 60 * 1000;
const MP3_KBPS = 32;
const MP3_FRAME = 1152;
const FRAMES_PER_YIELD = 50;

const MAX_WAVEFORM_SIZE = 100;
const HALF_SIZE = MAX_WAVEFORM_SIZE >>> 1;
const NOISE_BED = -60;

/** Signal-Desktop's `util/waveformBuilder.std.ts`: up to 100 bars of mean square energy, halving the resolution whenever it fills up. */
export class WaveformBuilder {
  readonly #waveform = new Float64Array(MAX_WAVEFORM_SIZE);
  readonly #secondHalf = this.#waveform.subarray(HALF_SIZE);
  #length = 0;
  #shift = 0;

  push(sample: number): void {
    let index = this.#length >>> this.#shift;
    if (index >= MAX_WAVEFORM_SIZE) {
      for (let i = 0; i < HALF_SIZE; i += 1) this.#waveform[i] = (this.#waveform[i * 2] + this.#waveform[i * 2 + 1]) / 2;
      this.#secondHalf.fill(0);
      this.#shift += 1;
      index = HALF_SIZE;
    }
    this.#waveform[index] += sample ** 2 / (1 << this.#shift);
    this.#length += 1;
  }

  collect(): number[] {
    let length = this.#length >>> this.#shift;
    const lastSamples = this.#length % (1 << this.#shift);
    if (lastSamples !== 0) {
      this.#waveform[length] = (this.#waveform[length] * (1 << this.#shift)) / lastSamples;
      length += 1;
    }
    const result = new Array<number>(length);
    for (let i = 0; i < length; i += 1) result[i] = toPeak(this.#waveform[i]);
    return result;
  }
}

export function toPeak(meanSquare: number): number {
  const val = Math.max(0, 10 * Math.log10(meanSquare) - NOISE_BED) / -NOISE_BED;
  return Math.round(val * 255);
}

/** A waveform squeezed (or stretched) to `count` bars for a bubble, each 0 to 1. */
export function waveformBars(waveform: number[], count: number): number[] {
  if (!waveform.length || count <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = Math.floor((i * waveform.length) / count);
    const b = Math.max(a + 1, Math.floor(((i + 1) * waveform.length) / count));
    let peak = 0;
    for (let j = a; j < b && j < waveform.length; j++) peak = Math.max(peak, waveform[j]);
    out.push(Math.max(0, Math.min(255, peak)) / 255);
  }
  return out;
}

export interface Mp3EncoderLike {
  encodeBuffer(left: Int16Array): Uint8Array | Int8Array;
  flush(): Uint8Array | Int8Array;
}

export interface VoiceNote {
  mp3: Uint8Array<ArrayBuffer>;
  waveform: number[];
  duration: number;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const pause = () => new Promise<void>((r) => setTimeout(r, 0));

function bytesOf(out: Uint8Array | Int8Array): Uint8Array {
  return new Uint8Array(out.buffer, out.byteOffset, out.length).slice();
}

/** MP3 frames and the waveform, built as mono samples arrive; only the MP3 is kept. */
export class VoiceEncoder {
  readonly #encoder: Mp3EncoderLike;
  readonly #rate: number;
  readonly #waveform = new WaveformBuilder();
  readonly #parts: Uint8Array[] = [];
  readonly #frame = new Int16Array(MP3_FRAME);
  #filled = 0;
  #samples = 0;
  /** Frames encoded so far. */
  frames = 0;

  constructor(encoder: Mp3EncoderLike, rate: number = VOICE_RATE) {
    this.#encoder = encoder;
    this.#rate = rate;
  }

  get samples(): number {
    return this.#samples;
  }

  push(pcm: Float32Array): void {
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      this.#waveform.push(s);
      this.#frame[this.#filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.#filled === MP3_FRAME) this.#encode(this.#frame);
    }
    this.#samples += pcm.length;
  }

  finish(): VoiceNote {
    if (this.#filled) this.#encode(this.#frame.slice(0, this.#filled));
    const last = this.#encoder.flush();
    if (last.length) this.#parts.push(bytesOf(last));
    return { mp3: concat(this.#parts), waveform: this.#waveform.collect(), duration: this.#samples / this.#rate };
  }

  #encode(block: Int16Array): void {
    const out = this.#encoder.encodeBuffer(block);
    if (out.length) this.#parts.push(bytesOf(out));
    this.#filled = 0;
    this.frames++;
  }
}

/** MP3, waveform, and length for mono PCM already in memory. It yields now and then so the screen stays responsive on a slow phone. */
export async function encodeVoice(pcm: Float32Array, rate: number = VOICE_RATE, encoder: Mp3EncoderLike = new Mp3Encoder(1, rate, MP3_KBPS), onProgress?: (fraction: number) => void, cancelled?: () => boolean): Promise<VoiceNote> {
  const enc = new VoiceEncoder(encoder, rate);
  const step = MP3_FRAME * FRAMES_PER_YIELD;
  for (let at = 0; at < pcm.length; at += step) {
    enc.push(pcm.subarray(at, Math.min(pcm.length, at + step)));
    if (onProgress) onProgress(Math.min(1, (at + step) / pcm.length));
    await pause();
    if (cancelled && cancelled()) throw new Error('cancelled');
  }
  return enc.finish();
}

export interface RecorderDeps {
  media(): Promise<MediaStream>;
  /** Hands the microphone to `onPcm` as 16 kHz mono blocks until it's closed. */
  capture(stream: MediaStream, onPcm: (pcm: Float32Array) => void): Promise<{ close(): void }>;
  encoder(rate: number): Mp3EncoderLike;
  now(): number;
}

function browserDeps(): RecorderDeps {
  return {
    media: () => navigator.mediaDevices.getUserMedia({ audio: true }),
    capture: async (stream, onPcm) => {
      const ctx = new AudioContext();
      try {
        await ctx.audioWorklet.addModule(WORKLET_URL);
        const node = new AudioWorkletNode(ctx, 'call-io', { numberOfInputs: 1, numberOfOutputs: 0, outputChannelCount: [], processorOptions: { capture: true, play: false } });
        node.port.onmessage = (e: MessageEvent) => {
          if (e.data && e.data.pcm instanceof Float32Array) onPcm(e.data.pcm);
        };
        ctx.createMediaStreamSource(stream).connect(node);
        if (ctx.state === 'suspended') await ctx.resume();
        return {
          close: () => {
            node.port.postMessage('stop');
            node.port.onmessage = null;
            node.disconnect();
            ctx.close().catch(() => {});
          },
        };
      } catch (e) {
        ctx.close().catch(() => {});
        throw e;
      }
    },
    encoder: (rate) => new Mp3Encoder(1, rate, MP3_KBPS),
    now: () => Date.now(),
  };
}

export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopped' | 'encoding' | 'done' | 'cancelled' | 'failed';

/** One recording: start, stop (by hand or at the limit), then finish to get the voice message, or cancel. */
export class VoiceRecorder {
  state: RecorderState = 'idle';
  #deps: RecorderDeps;
  #maxMs: number;
  #stream: MediaStream | null = null;
  #tap: { close(): void } | null = null;
  #encoder: VoiceEncoder | null = null;
  #level = 0;
  #startedAt = 0;
  #stoppedAt = 0;
  #limit: ReturnType<typeof setTimeout> | null = null;
  /** Runs when the recording stops by itself at the limit. */
  onLimit: (() => void) | null = null;

  constructor(deps: RecorderDeps = browserDeps(), opts: { maxMs?: number } = {}) {
    this.#deps = deps;
    this.#maxMs = opts.maxMs || MAX_VOICE_MS;
  }

  /** Asks for the microphone and starts recording; rejects when it's refused or unavailable. */
  async start(): Promise<void> {
    if (this.state !== 'idle') throw new Error('Already started');
    this.state = 'starting';
    try {
      const stream = await this.#deps.media();
      if (this.state !== 'starting') {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.#stream = stream;
      this.#encoder = new VoiceEncoder(this.#deps.encoder(VOICE_RATE));
      const tap = await this.#deps.capture(stream, (pcm) => this.#onPcm(pcm));
      if (this.state !== 'starting') {
        tap.close();
        return;
      }
      this.#tap = tap;
      this.#startedAt = this.#deps.now();
      this.state = 'recording';
      this.#limit = setTimeout(() => {
        this.stop().then(() => this.onLimit && this.onLimit(), () => {});
      }, this.#maxMs);
    } catch (e) {
      this.#release();
      this.state = 'failed';
      throw e;
    }
  }

  #onPcm(pcm: Float32Array): void {
    if (this.state !== 'recording' || !this.#encoder) return;
    this.#encoder.push(pcm);
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
    this.#level = pcm.length ? toPeak(sum / pcm.length) : 0;
  }

  elapsedMs(): number {
    if (!this.#startedAt) return 0;
    return Math.min(this.#maxMs, (this.#stoppedAt || this.#deps.now()) - this.#startedAt);
  }

  level(): number {
    return this.state === 'recording' ? this.#level : 0;
  }

  /** Ends the recording and lets go of the microphone. */
  async stop(): Promise<void> {
    if (this.state !== 'recording') return;
    this.#stoppedAt = this.#deps.now();
    this.state = 'stopped';
    this.#release();
  }

  /** The recording as a voice message. */
  async finish(onProgress?: (fraction: number) => void): Promise<VoiceNote> {
    if (this.state !== 'stopped' || !this.#encoder) throw new Error('Not stopped');
    this.state = 'encoding';
    const enc = this.#encoder;
    this.#encoder = null;
    try {
      if (!enc.samples) throw new Error('Nothing was recorded');
      const note = enc.finish();
      if (onProgress) onProgress(1);
      this.state = 'done';
      return note;
    } catch (e) {
      this.state = 'failed';
      throw e;
    }
  }

  cancel(): void {
    this.#release();
    this.#encoder = null;
    this.state = 'cancelled';
  }

  #release(): void {
    if (this.#limit) clearTimeout(this.#limit);
    this.#limit = null;
    if (this.#tap) this.#tap.close();
    this.#tap = null;
    if (this.#stream) this.#stream.getTracks().forEach((t) => t.stop());
    this.#stream = null;
  }
}

/** A voice message ready for `sendAttachments`: an MP3 with no file name, as Signal-Desktop sends them. */
export async function voiceNoteFile(note: VoiceNote): Promise<OutgoingFile> {
  const blob = new Blob([note.mp3], { type: 'audio/mpeg' });
  return { dataUri: await readDataUri(blob), contentType: 'audio/mpeg', filename: '', size: note.mp3.length, voiceNote: true, waveform: note.waveform, duration: note.duration };
}
