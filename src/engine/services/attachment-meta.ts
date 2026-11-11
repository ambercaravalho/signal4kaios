/* What an attachment pointer says about its content beyond the file itself: a voice message's waveform and length, and a photo's or video's size and blurred placeholder, as Signal-Desktop sends and reads them. */

import { type AttachmentPointer, AttachmentPointer_Flags } from '../gen/SignalService_pb';

/** `audioWaveform` in SignalService.proto: at most 100 bars, each 0 to 255. */
const MAX_WAVEFORM_LENGTH = 100;
const MAX_AUDIO_SECONDS = 24 * 3600;
const MAX_EDGE = 20000;
/** Blurhash's base 83 alphabet; Signal's hashes are a few dozen characters. */
const BLURHASH_RE = /^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]{6,120}$/;

export interface AttachmentMeta {
  voice?: boolean;
  waveform?: number[];
  duration?: number;
  blurHash?: string;
  width?: number;
  height?: number;
}

export interface ReceivedMeta {
  waveform?: number[];
  duration?: number;
  blurHash?: string;
  width?: number;
  height?: number;
}

function validDuration(d: unknown): d is number {
  return typeof d === 'number' && isFinite(d) && d > 0 && d <= MAX_AUDIO_SECONDS;
}

function validEdge(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_EDGE;
}

function isVisual(type: string): boolean {
  return type.indexOf('image/') === 0 || type.indexOf('video/') === 0;
}

/** Sets what `meta` describes on a freshly uploaded pointer; values out of range are left off. */
export function applyAttachmentMeta(ptr: AttachmentPointer, meta: AttachmentMeta | null | undefined): void {
  if (!meta) return;
  const type = ptr.contentType || '';
  if (meta.voice) ptr.flags |= AttachmentPointer_Flags.VOICE_MESSAGE;
  if (isVisual(type)) {
    if (typeof meta.blurHash === 'string' && BLURHASH_RE.test(meta.blurHash)) ptr.blurHash = meta.blurHash;
    if (validEdge(meta.width) && validEdge(meta.height)) {
      ptr.width = meta.width;
      ptr.height = meta.height;
    }
  }
  if (type.indexOf('audio/') !== 0) return;
  const w = meta.waveform;
  if (Array.isArray(w) && w.length > 0 && w.length <= MAX_WAVEFORM_LENGTH && w.every((v) => typeof v === 'number' && v >= 0 && v <= 255)) {
    ptr.audioWaveform = Uint8Array.from(w, (v) => Math.round(v));
  }
  if (validDuration(meta.duration)) ptr.audioDurationSeconds = meta.duration;
}

/** A received pointer's waveform (cut to 100 bars) and length, or its size and placeholder, when it has them. */
export function receivedMeta(ptr: AttachmentPointer): ReceivedMeta {
  const out: ReceivedMeta = {};
  const type = ptr.contentType || '';
  if (isVisual(type)) {
    if (BLURHASH_RE.test(ptr.blurHash || '')) out.blurHash = ptr.blurHash;
    if (validEdge(ptr.width) && validEdge(ptr.height)) {
      out.width = ptr.width;
      out.height = ptr.height;
    }
    return out;
  }
  if (type.indexOf('audio/') !== 0) return out;
  if (ptr.audioWaveform && ptr.audioWaveform.length > 0) out.waveform = Array.from(ptr.audioWaveform.subarray(0, MAX_WAVEFORM_LENGTH));
  if (validDuration(ptr.audioDurationSeconds)) out.duration = ptr.audioDurationSeconds;
  return out;
}
