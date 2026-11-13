/* A voice call, drawn over whatever screen is showing while the call lasts. Incoming: Answer with OK or Call, Decline with the left softkey, End, or Back. In a call: the left softkey moves it between the earpiece and the speaker, OK mutes, and the right softkey or End hangs up. */

import { useEffect, useState } from 'preact/hooks';
import { router, useKeys, useSoftkeys } from '../app/router';
import { useTicker } from '../app/hooks';
import { Avatar, type AvatarSubject } from '../components/Avatar';
import type { CallEndReason } from '../../engine';
import { answerCall, callConversation, callView, closeCall, declineCall, hangUp, installCalls, onCallView, toggleMute, toggleSpeaker, type CallView } from '../data/calls';
import { fmtLength } from '../data/format';
import { displayName } from '../data/store';
import { fmt, S } from '../strings';

/** How long the ended call stays on screen. */
const ENDED_MS = 2500;

function endText(reason: CallEndReason | null, name: string, view: CallView): string {
  if (view.problem === 'mic') return S.callNeedsMic;
  switch (reason) {
    case 'declined':
    case 'remoteDeclined':
      return S.callDeclined;
    case 'missed':
      return S.callMissed;
    case 'busy':
      return fmt(S.callBusy, { name });
    case 'noAnswer':
      return S.callNoAnswer;
    case 'acceptedElsewhere':
      return S.answeredElsewhere;
    case 'declinedElsewhere':
      return S.declinedElsewhere;
    case 'busyElsewhere':
      return S.busyElsewhere;
    case 'needPermission':
      return fmt(S.callNeedsRequest, { name });
    case 'failed':
      return S.callFailed;
    default:
      return S.callEnded;
  }
}

function statusText(view: CallView, name: string): string {
  const c = view.call;
  switch (c.phase) {
    case 'incoming':
      return S.incomingVoiceCall;
    case 'outgoing':
      return S.calling;
    case 'ringing':
      return S.ringing;
    case 'connecting':
      return S.connecting;
    case 'connected':
      return fmtLength((Date.now() - (c.connectedAt || Date.now())) / 1000);
    default:
      return endText(c.endReason, name, view);
  }
}

function useCallView(): CallView | null {
  const [, setN] = useState(0);
  useEffect(() => onCallView(() => setN((n) => n + 1)), []);
  return callView();
}

export function CallScreen() {
  const view = useCallView();
  const c = view && view.call;
  const phase = c ? c.phase : 'ended';
  useTicker(1000, phase === 'connected');

  useEffect(() => {
    if (phase !== 'ended') return;
    const t = setTimeout(closeCall, ENDED_MS);
    return () => clearTimeout(t);
  }, [phase, c && c.callId]);

  const incoming = phase === 'incoming';
  const live = !incoming && phase !== 'ended';
  useSoftkeys(incoming ? { left: S.decline, center: S.answer, right: null } : live ? { left: view && view.speaker ? S.speakerOff : S.speaker, center: c && c.muted ? S.unmute : S.mute, right: S.endCall } : { left: null, center: S.ok, right: null });
  useKeys((e) => {
    if (incoming) {
      if (e.key === 'Enter' || e.key === 'Call') answerCall();
      else if (e.key === 'SoftLeft' || e.key === 'EndCall' || e.key === 'Backspace') declineCall();
      return true;
    }
    if (live) {
      if (e.key === 'SoftLeft') toggleSpeaker();
      else if (e.key === 'Enter') toggleMute();
      else if (e.key === 'SoftRight' || e.key === 'EndCall') hangUp();
      // Back stays here: leaving the call screen would leave no way back to it.
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Backspace' || e.key === 'SoftLeft' || e.key === 'SoftRight' || e.key === 'EndCall') closeCall();
    return true;
  });

  if (!view || !c) return <div class="call" />;
  const conv = callConversation(c.peer);
  const known = displayName(c.peer);
  const name = conv ? conv.name : known !== c.peer ? known : S.unknown;
  const subject: AvatarSubject = conv || { id: c.peer, type: 'direct', name };
  return (
    <div class="call" role="dialog">
      <div class="hdr">{S.voiceCall}</div>
      <div class="call-body">
        <Avatar conv={subject} size="lg" />
        <div class="call-name">{name}</div>
        <div class={'call-status' + (phase === 'ended' ? ' call-ended' : '')}>{statusText(view, name)}</div>
        {live && c.muted && <div class="call-flag">{S.youAreMuted}</div>}
        {live && c.remoteMuted && <div class="call-flag">{fmt(S.peerMuted, { name })}</div>}
      </div>
    </div>
  );
}

/** Opens the call screen over everything else when a call starts, and closes it once the call is cleared. */
export function installCallScreen(): void {
  installCalls();
  const sync = () => {
    const shown = router.has(CallScreen);
    if (callView() && !shown) router.overlay(CallScreen, {});
    else if (!callView() && shown) router.remove(CallScreen);
  };
  onCallView(sync);
  sync();
}
