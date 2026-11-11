/* Records a voice message. Gecko's MediaRecorder only makes Ogg Opus, which not every Signal app plays, so the recording is decoded to mono 16 kHz PCM and sent as MP3 with a waveform and length, as Signal-Desktop sends them. */

import { Mp3Encoder } from '@breezystack/lamejs';
import { readDataUri } from './attachments';
import type { OutgoingFile } from './store';

const VOICE_RATE = 16000;
const MAX_VOICE_MS = 15 * 60 * 1000;
const MP3_KBPS = 32;
const MP3_FRAME = 1152;
const FRAMES_PER_YIELD = 50;
const RECORDER_SLICE_MS = 1000;

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

/** The channels averaged to one, then each output sample the mean of the input samples it covers. */
export function toMono(channels: Float32Array[], fromRate: number, toRate: number = VOICE_RATE): Float32Array {
  const n = channels.length ? channels[0].length : 0;
  const mono = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;
  if (fromRate === toRate || !n) return mono;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(n / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.max(a + 1, Math.min(n, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = a; j < b; j++) sum += mono[j];
    out[i] = sum / (b - a);
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

/** MP3, waveform, and length for mono PCM. It yields now and then so the screen stays responsive on a slow phone. */
export async function encodeVoice(pcm: Float32Array, rate: number = VOICE_RATE, encoder: Mp3EncoderLike = new Mp3Encoder(1, rate, MP3_KBPS), onProgress?: (fraction: number) => void, cancelled?: () => boolean): Promise<VoiceNote> {
  const waveform = new WaveformBuilder();
  const parts: Uint8Array[] = [];
  const frame = new Int16Array(MP3_FRAME);
  let frames = 0;
  for (let at = 0; at < pcm.length; at += MP3_FRAME) {
    const end = Math.min(pcm.length, at + MP3_FRAME);
    const block = end - at === MP3_FRAME ? frame : new Int16Array(end - at);
    for (let i = at; i < end; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      waveform.push(s);
      block[i - at] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const out = encoder.encodeBuffer(block);
    if (out.length) parts.push(new Uint8Array(out.buffer, out.byteOffset, out.length).slice());
    if (++frames % FRAMES_PER_YIELD === 0) {
      if (onProgress) onProgress(end / pcm.length);
      await pause();
      if (cancelled && cancelled()) throw new Error('cancelled');
    }
  }
  const last = encoder.flush();
  if (last.length) parts.push(new Uint8Array(last.buffer, last.byteOffset, last.length).slice());
  return { mp3: concat(parts), waveform: waveform.collect(), duration: pcm.length / rate };
}

export interface MediaRecorderLike {
  readonly mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface RecorderDeps {
  media(): Promise<MediaStream>;
  recorder(stream: MediaStream): MediaRecorderLike;
  /** A live level, 0 to 255, or null where the phone can't measure it. */
  meter(stream: MediaStream): { level(): number; close(): void } | null;
  decode(recording: Blob): Promise<{ channels: Float32Array[]; rate: number }>;
  encoder(rate: number): Mp3EncoderLike;
  now(): number;
}

const OGG_OPUS = 'audio/ogg;codecs=opus';

function browserDeps(): RecorderDeps {
  return {
    media: () => navigator.mediaDevices.getUserMedia({ audio: true }),
    recorder: (stream) => {
      const R = (window as unknown as { MediaRecorder: typeof MediaRecorder }).MediaRecorder;
      return new R(stream, R.isTypeSupported && R.isTypeSupported(OGG_OPUS) ? { mimeType: OGG_OPUS } : undefined) as unknown as MediaRecorderLike;
    },
    meter: (stream) => {
      try {
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        return {
          level: () => {
            analyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            return toPeak(sum / buf.length);
          },
          close: () => {
            ctx.close().catch(() => {});
          },
        };
      } catch {
        return null;
      }
    },
    decode: async (recording) => {
      const audio = await new OfflineAudioContext(1, 1, VOICE_RATE).decodeAudioData(await recording.arrayBuffer());
      const channels: Float32Array[] = [];
      for (let i = 0; i < audio.numberOfChannels; i++) channels.push(audio.getChannelData(i));
      return { channels, rate: audio.sampleRate };
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
  #rec: MediaRecorderLike | null = null;
  #meter: { level(): number; close(): void } | null = null;
  #chunks: Blob[] = [];
  #type = OGG_OPUS;
  #startedAt = 0;
  #stoppedAt = 0;
  #limit: ReturnType<typeof setTimeout> | null = null;
  #stopped: Promise<void> | null = null;
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
      const rec = this.#deps.recorder(stream);
      this.#rec = rec;
      this.#type = rec.mimeType || OGG_OPUS;
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) this.#chunks.push(e.data);
      };
      this.#stopped = new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
        rec.onerror = () => {
          if (this.state === 'recording') this.state = 'failed';
          resolve();
        };
      });
      rec.start(RECORDER_SLICE_MS);
      this.#meter = this.#deps.meter(stream);
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

  elapsedMs(): number {
    if (!this.#startedAt) return 0;
    return Math.min(this.#maxMs, (this.#stoppedAt || this.#deps.now()) - this.#startedAt);
  }

  level(): number {
    return this.state === 'recording' && this.#meter ? this.#meter.level() : 0;
  }

  /** Ends the recording and lets go of the microphone. */
  async stop(): Promise<void> {
    if (this.state !== 'recording') return;
    this.#stoppedAt = this.#deps.now();
    this.state = 'stopped';
    const done = this.#stopped;
    try {
      if (this.#rec) this.#rec.stop();
    } catch {
      /* already inactive */
    }
    this.#release();
    if (done) await done;
  }

  /** The recording as a voice message. */
  async finish(onProgress?: (fraction: number) => void): Promise<VoiceNote> {
    if (this.state !== 'stopped') throw new Error('Not stopped');
    this.state = 'encoding';
    try {
      const { channels, rate } = await this.#deps.decode(new Blob(this.#chunks, { type: this.#type }));
      this.#chunks = [];
      if (this.#cancelled()) throw new Error('cancelled');
      const pcm = toMono(channels, rate, VOICE_RATE);
      if (!pcm.length) throw new Error('Nothing was recorded');
      const note = await encodeVoice(pcm, VOICE_RATE, this.#deps.encoder(VOICE_RATE), onProgress, () => this.#cancelled());
      if (this.#cancelled()) throw new Error('cancelled');
      this.state = 'done';
      return note;
    } catch (e) {
      if (!this.#cancelled()) this.state = 'failed';
      throw e;
    }
  }

  #cancelled(): boolean {
    return this.state === 'cancelled';
  }

  cancel(): void {
    if (this.state === 'recording') {
      try {
        if (this.#rec) this.#rec.stop();
      } catch {
        /* already inactive */
      }
    }
    this.#release();
    this.#chunks = [];
    this.state = 'cancelled';
  }

  #release(): void {
    if (this.#limit) clearTimeout(this.#limit);
    this.#limit = null;
    if (this.#meter) this.#meter.close();
    this.#meter = null;
    if (this.#stream) this.#stream.getTracks().forEach((t) => t.stop());
    this.#stream = null;
  }
}

/** A voice message ready for `sendAttachments`: an MP3 with no file name, as Signal-Desktop sends them. */
export async function voiceNoteFile(note: VoiceNote): Promise<OutgoingFile> {
  const blob = new Blob([note.mp3], { type: 'audio/mpeg' });
  return { dataUri: await readDataUri(blob), contentType: 'audio/mpeg', filename: '', size: note.mp3.length, voiceNote: true, waveform: note.waveform, duration: note.duration };
}
