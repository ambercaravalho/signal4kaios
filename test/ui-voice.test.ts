import './ui-env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { create } from '@bufbuild/protobuf';
import { AttachmentPointer_Flags, AttachmentPointerSchema } from '../src/engine/gen/SignalService_pb';
import { applyAttachmentMeta, receivedMeta } from '../src/engine/services/attachment-meta';
import { fileNameFor } from '../src/ui/data/attachments';
import { fmtLength } from '../src/ui/data/format';
import { attachmentLabel } from '../src/ui/data/store';
import { encodeVoice, type RecorderDeps, toPeak, VoiceEncoder, VoiceRecorder, voiceNoteFile, WaveformBuilder, waveformBars } from '../src/ui/data/voice-recorder';
import { settle } from './helpers';

function waveformOf(samples: ArrayLike<number>): number[] {
  const b = new WaveformBuilder();
  for (let i = 0; i < samples.length; i++) b.push(samples[i]);
  return b.collect();
}

class FakeEncoder {
  samples = 0;
  encodeBuffer(left: Int16Array): Uint8Array {
    this.samples += left.length;
    return new Uint8Array([0xff]);
  }
  flush(): Uint8Array {
    return new Uint8Array([0xee]);
  }
}

function fakeDeps(over: Partial<RecorderDeps> = {}) {
  const log = { tracksStopped: 0, tapClosed: false, started: false, encoder: new FakeEncoder(), feed: null as ((pcm: Float32Array) => void) | null };
  let clock = 1000;
  const deps: RecorderDeps & { advance(ms: number): void } = {
    advance: (ms) => {
      clock += ms;
    },
    media: async () => ({ getTracks: () => [{ stop: () => log.tracksStopped++ }] }) as unknown as MediaStream,
    capture: async (_stream, onPcm) => {
      log.started = true;
      log.feed = onPcm;
      return {
        close: () => {
          log.tapClosed = true;
        },
      };
    },
    encoder: () => log.encoder,
    now: () => clock,
    ...over,
  };
  return { deps, log };
}

describe('voice messages', () => {
  it('builds the waveform as Signal-Desktop does', () => {
    const loud = toPeak(0.25);
    assert.equal(loud, 229);
    assert.deepEqual(waveformOf(new Float32Array(100).fill(0.5)), new Array(100).fill(loud));
    assert.deepEqual(waveformOf(new Float32Array(40).fill(0)), new Array(40).fill(0));

    const long = new Float32Array(16000);
    long.fill(0.5, 8000);
    const bars = waveformOf(long);
    assert.ok(bars.length <= 100 && bars.length > 50);
    assert.equal(bars[0], 0);
    assert.equal(bars[bars.length - 1], loud);
    assert.ok(bars.every((v) => v === 0 || v === loud || (v > 0 && v < loud)));
  });

  it('encodes MP3 frames with lamejs', async () => {
    const pcm = new Float32Array(16000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / 16000);
    const note = await encodeVoice(pcm);
    assert.equal(note.duration, 1);
    assert.ok(note.mp3.length > 1000);
    assert.equal(note.mp3[0], 0xff);
    assert.equal(note.mp3[1] & 0xe0, 0xe0);
    assert.ok(note.waveform.length > 0 && note.waveform.length <= 100);

    const file = await voiceNoteFile(note);
    assert.equal(file.contentType, 'audio/mpeg');
    assert.equal(file.filename, '');
    assert.equal(file.voiceNote, true);
    assert.ok(file.dataUri.indexOf('data:audio/mpeg;base64,') === 0);
  });

  it('records, stops, and hands back the MP3, waveform, and length', async () => {
    const { deps, log } = fakeDeps();
    const rec = new VoiceRecorder(deps);
    assert.equal(rec.state, 'idle');
    await rec.start();
    assert.equal(rec.state, 'recording');
    assert.equal(log.started, true);
    for (let i = 0; i < 50; i++) log.feed!(new Float32Array(320).fill(0.5));
    assert.equal(rec.level(), toPeak(0.25));
    assert.equal(log.encoder.samples, 13 * 1152, 'whole MP3 frames are encoded as the audio arrives');
    deps.advance(4500);
    assert.equal(rec.elapsedMs(), 4500);
    await assert.rejects(rec.finish());

    await rec.stop();
    assert.equal(rec.state, 'stopped');
    assert.equal(log.tracksStopped, 1);
    assert.equal(log.tapClosed, true);
    assert.equal(rec.level(), 0);
    log.feed!(new Float32Array(320).fill(0.5));
    deps.advance(1000);
    assert.equal(rec.elapsedMs(), 4500);

    const note = await rec.finish();
    assert.equal(rec.state, 'done');
    assert.equal(log.encoder.samples, 16000, 'audio after Stop is left out');
    assert.equal(note.duration, 1);
    assert.deepEqual(Array.from(note.mp3.slice(-2)), [0xff, 0xee]);
    assert.ok(note.waveform.every((v) => v === toPeak(0.25)));
  });

  it('keeps only MP3 bytes while recording, however long it runs', () => {
    const enc = new VoiceEncoder(new FakeEncoder());
    const block = new Float32Array(320).fill(0.1);
    for (let i = 0; i < 16000 * 60 * 15 / 320; i++) enc.push(block);
    const note = enc.finish();
    assert.equal(note.duration, 15 * 60);
    assert.equal(note.mp3.length, enc.frames + 1, 'one fake byte per frame plus the flush');
    assert.ok(note.waveform.length <= 100);
  });

  it('stops by itself at the limit', async () => {
    const { deps } = fakeDeps();
    const rec = new VoiceRecorder(deps, { maxMs: 20 });
    let limited = false;
    rec.onLimit = () => {
      limited = true;
    };
    await rec.start();
    await settle(60);
    assert.equal(rec.state, 'stopped');
    assert.equal(limited, true);
  });

  it('fails without the microphone or with nothing recorded, and cancelling drops the recording', async () => {
    const denied = new VoiceRecorder(fakeDeps({ media: () => Promise.reject(new Error('NotAllowedError')) }).deps);
    await assert.rejects(denied.start());
    assert.equal(denied.state, 'failed');

    const noWorklet = fakeDeps({ capture: () => Promise.reject(new Error('NotSupportedError')) });
    const broken = new VoiceRecorder(noWorklet.deps);
    await assert.rejects(broken.start());
    assert.equal(noWorklet.log.tracksStopped, 1, 'the microphone is let go');

    const { deps, log } = fakeDeps();
    const rec = new VoiceRecorder(deps);
    await rec.start();
    log.feed!(new Float32Array(320));
    rec.cancel();
    assert.equal(rec.state, 'cancelled');
    assert.equal(log.tracksStopped, 1);
    assert.equal(log.tapClosed, true);
    await assert.rejects(rec.finish());

    const silent = new VoiceRecorder(fakeDeps().deps);
    await silent.start();
    await silent.stop();
    await assert.rejects(silent.finish(), /Nothing was recorded/);
  });

  it('puts the waveform, length, and voice flag on the pointer', () => {
    const ptr = create(AttachmentPointerSchema, { contentType: 'audio/mpeg' });
    applyAttachmentMeta(ptr, { voice: true, waveform: [0, 128, 255], duration: 3.5 });
    assert.equal(ptr.flags & AttachmentPointer_Flags.VOICE_MESSAGE, AttachmentPointer_Flags.VOICE_MESSAGE);
    assert.deepEqual(Array.from(ptr.audioWaveform), [0, 128, 255]);
    assert.equal(ptr.audioDurationSeconds, 3.5);

    const bad = create(AttachmentPointerSchema, { contentType: 'audio/mpeg' });
    applyAttachmentMeta(bad, { waveform: [0, 300], duration: -1 });
    assert.equal(bad.audioWaveform.length, 0);
    assert.equal(bad.audioDurationSeconds, 0);
    assert.equal(bad.flags, 0);

    const photo = create(AttachmentPointerSchema, { contentType: 'image/jpeg' });
    applyAttachmentMeta(photo, { waveform: [1, 2], duration: 2 });
    assert.equal(photo.audioWaveform.length, 0);
  });

  it('reads at most 100 bars and a sane length from received pointers', () => {
    const ptr = create(AttachmentPointerSchema, { contentType: 'audio/mpeg', audioWaveform: new Uint8Array(250).fill(7), audioDurationSeconds: 12.25 });
    const meta = receivedMeta(ptr);
    assert.equal(meta.waveform!.length, 100);
    assert.equal(meta.duration, 12.25);
    assert.deepEqual(receivedMeta(create(AttachmentPointerSchema, { contentType: 'audio/mpeg', audioDurationSeconds: Infinity })), {});
    assert.deepEqual(receivedMeta(create(AttachmentPointerSchema, { contentType: 'image/png', audioWaveform: new Uint8Array([1]) })), {});
  });

  it('saves a voice message under the time it was sent, and labels picked audio by its name', () => {
    const sentAt = new Date(2026, 10, 16, 9, 5, 7).getTime();
    assert.equal(fileNameFor({ id: 'v', contentType: 'audio/mpeg', filename: '', size: 1, voiceNote: true }, 'audio/mpeg', sentAt), 'signal-2026-11-16-090507.mp3');
    assert.equal(fileNameFor({ id: 's', contentType: 'audio/mpeg', filename: 'song.mp3', size: 1 }, 'audio/mpeg', sentAt), 'song.mp3');
    assert.equal(attachmentLabel([{ contentType: 'audio/mpeg', voiceNote: true }]), 'Voice message');
    assert.equal(attachmentLabel([{ contentType: 'audio/mpeg', filename: 'song.mp3' }]), 'song.mp3');
    assert.equal(attachmentLabel([{ contentType: 'audio/mpeg' }]), 'Audio');
  });

  it('draws bubble bars and lengths', () => {
    assert.deepEqual(waveformBars([0, 255, 51, 102], 2), [1, 0.4]);
    assert.equal(waveformBars(new Array(100).fill(255), 32).length, 32);
    assert.deepEqual(waveformBars([255], 3), [1, 1, 1]);
    assert.deepEqual(waveformBars([], 3), []);
    assert.equal(fmtLength(7.9), '0:07');
    assert.equal(fmtLength(225), '3:45');
    assert.equal(fmtLength(3723), '1:02:03');
  });
});
