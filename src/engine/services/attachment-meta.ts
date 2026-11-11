/* What an attachment pointer says about its content beyond the file itself: a voice message's waveform and length, as Signal-Desktop sends and reads them. */

import { type AttachmentPointer, AttachmentPointer_Flags } from '../gen/SignalService_pb';

/** `audioWaveform` in SignalService.proto: at most 100 bars, each 0 to 255. */
export const MAX_WAVEFORM_LENGTH = 100;
const MAX_AUDIO_SECONDS = 24 * 3600;

export interface AttachmentMeta {
  voice?: boolean;
  waveform?: number[];
  duration?: number;
}

function validDuration(d: unknown): d is number {
  return typeof d === 'number' && isFinite(d) && d > 0 && d <= MAX_AUDIO_SECONDS;
}

/** Sets what `meta` describes on a freshly uploaded pointer; values out of range are left off. */
export function applyAttachmentMeta(ptr: AttachmentPointer, meta: AttachmentMeta | null | undefined): void {
  if (!meta) return;
  if (meta.voice) ptr.flags |= AttachmentPointer_Flags.VOICE_MESSAGE;
  const audio = (ptr.contentType || '').indexOf('audio/') === 0;
  if (!audio) return;
  const w = meta.waveform;
  if (Array.isArray(w) && w.length > 0 && w.length <= MAX_WAVEFORM_LENGTH && w.every((v) => typeof v === 'number' && v >= 0 && v <= 255)) {
    ptr.audioWaveform = Uint8Array.from(w, (v) => Math.round(v));
  }
  if (validDuration(meta.duration)) ptr.audioDurationSeconds = meta.duration;
}

/** A received pointer's waveform (cut to 100 bars) and length, when it has them. */
export function receivedAudioMeta(ptr: AttachmentPointer): { waveform?: number[]; duration?: number } {
  const out: { waveform?: number[]; duration?: number } = {};
  if ((ptr.contentType || '').indexOf('audio/') !== 0) return out;
  if (ptr.audioWaveform && ptr.audioWaveform.length > 0) out.waveform = Array.from(ptr.audioWaveform.subarray(0, MAX_WAVEFORM_LENGTH));
  if (validDuration(ptr.audioDurationSeconds)) out.duration = ptr.audioDurationSeconds;
  return out;
}
