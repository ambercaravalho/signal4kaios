/* The voice message sheet: it records at once, shows the time and a live level, and Stop then Send hands back the finished voice message. */

import { useEffect, useRef, useState } from 'preact/hooks';
import { router, useKeys, useSoftkeys } from '../app/router';
import { fmtLength } from '../data/format';
import { VoiceRecorder, type VoiceNote } from '../data/voice-recorder';
import { fmt, S } from '../strings';
import { Icon } from './Icon';
import { toast } from './Toast';

const TICK_MS = 100;

function RecorderView(props: { recorder: VoiceRecorder; resolve(note: VoiceNote | null): void }) {
  const rec = props.recorder;
  const [, tick] = useState(0);
  const [progress, setProgress] = useState(0);
  const settled = useRef(false);

  const done = (note: VoiceNote | null, message?: string) => {
    if (settled.current) return;
    settled.current = true;
    if (!note) rec.cancel();
    router.pop();
    if (message) toast(message);
    props.resolve(note);
  };

  useEffect(() => {
    rec.onLimit = () => {
      toast(S.voiceLimitReached);
      tick((n) => n + 1);
    };
    rec.start().then(
      () => tick((n) => n + 1),
      () => done(null, S.micUnavailable)
    );
    const timer = setInterval(() => tick((n) => n + 1), TICK_MS);
    return () => {
      clearInterval(timer);
      rec.onLimit = null;
      if (!settled.current) {
        settled.current = true;
        rec.cancel();
        props.resolve(null);
      }
    };
  }, []);

  function send(): void {
    if (rec.state !== 'stopped') return;
    tick((n) => n + 1);
    rec.finish((p) => setProgress(p)).then(
      (note) => done(note),
      (e) => done(null, rec.state === 'cancelled' ? undefined : e && e.message === 'Nothing was recorded' ? S.nothingRecorded : S.voiceFailed)
    );
  }

  const state = rec.state;
  const recording = state === 'recording' || state === 'starting' || state === 'idle';
  useSoftkeys({ left: S.cancel, center: state === 'recording' ? S.stop : state === 'stopped' ? S.send : null, right: null });
  useKeys((e) => {
    if (e.key === 'Enter') {
      if (rec.state === 'recording') rec.stop().then(() => tick((n) => n + 1));
      else send();
    } else if (e.key === 'SoftLeft' || e.key === 'Backspace') done(null);
    else return false;
    return true;
  });

  const level = Math.round((rec.level() / 255) * 100);
  return (
    <div class="dialog" role="dialog">
      <div class="dialog-title">{recording ? S.recordingVoice : S.voiceMessage}</div>
      <div class="voice-rec">
        <Icon name="mic" class={state === 'recording' ? 'voice-rec-live' : ''} />
        <span class="voice-rec-time">{fmtLength(rec.elapsedMs() / 1000)}</span>
        <span class="voice-rec-level">
          <span class="voice-rec-fill" style={{ width: level + '%' }} />
        </span>
      </div>
      {state === 'encoding' && <div class="dialog-hint">{fmt(S.preparingVoice, { n: Math.round(progress * 100) })}</div>}
    </div>
  );
}

/** Records a voice message; resolves null when it's cancelled or the microphone can't be used. */
export function recordVoice(recorder: VoiceRecorder = new VoiceRecorder()): Promise<VoiceNote | null> {
  return new Promise((resolve) => router.overlay(RecorderView, { recorder, resolve }));
}
