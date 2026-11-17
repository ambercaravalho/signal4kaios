/* The app's side of a voice call: it rings, keeps the phone awake, runs the microphone and speaker while the call is live, and tells the call screen what to show. The engine keeps the call itself. */

import type { CallState } from '../../engine';
import { isUuid } from '../../engine/validate';
import { signal } from './api';
import { CallAudioIO } from './call-audio';
import { CallTone } from './call-tones';
import { dbg } from './log';
import { chatFor, contactByKey, dismissNotifications, notifyIncomingCall, shouldNotify } from './store';
import type { Conversation } from './types';

/** Why the call couldn't go on, beyond the engine's end reasons. */
export type CallProblem = 'mic' | null;

export interface CallView {
  call: CallState;
  speaker: boolean;
  problem: CallProblem;
}

type WakeLock = { unlock(): void };

const listeners = new Set<() => void>();
const tone = new CallTone();
let state: CallState | null = null;
let speaker = false;
let problem: CallProblem = null;
let audio: CallAudioIO | null = null;
let ignoredId: string | null = null;
let silencedId: string | null = null;
let answeringId: string | null = null;
let notifiedConv: string | null = null;
let cpuLock: WakeLock | null = null;
let screenLock: WakeLock | null = null;

export function installCalls(): void {
  signal.setCallFilter(ringsHere);
  signal.onCallState(onState);
  const s = signal.callState();
  if (s) onState(s);
}

/** The call to show, or null when there's none (or it's one Beacon ignored). */
export function callView(): CallView | null {
  if (!state || state.callId === ignoredId) return null;
  return { call: state, speaker, problem };
}

export function onCallView(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The 1:1 chat with whoever is on the call, if there is one. */
export function callConversation(peer: string): Conversation | undefined {
  return chatFor({ key: peer });
}

/** Who to call in a 1:1 chat, or null when the chat can't be called (a group, ourselves, or someone whose account ID isn't known yet). */
export function callablePeer(conv: Conversation | undefined): string | null {
  if (!conv || conv.type !== 'direct') return null;
  if (conv.sendId && isUuid(conv.sendId)) return conv.sendId;
  const c = contactByKey(conv.id);
  return c && c.uuid && isUuid(c.uuid) ? c.uuid : null;
}

export function inCall(): boolean {
  return !!state && state.phase !== 'ended';
}

export function placeCall(peer: string): Promise<void> {
  return signal.startCall(peer);
}

/** Opens the microphone, then accepts, so the first words aren't lost while it starts; a call the microphone can't open for is declined. */
export function answerCall(): void {
  if (!state || state.direction !== 'incoming' || state.phase !== 'incoming' || answeringId === state.callId) return;
  const id = state.callId;
  answeringId = id;
  tone.stop();
  const io = audio || new CallAudioIO(signal);
  const opening = audio ? Promise.resolve() : io.start(speaker);
  audio = io;
  opening.then(
    () => {
      if (audio === io && state && state.callId === id) signal.acceptCall();
    },
    (e) => {
      if (audio !== io) return;
      dbg('call: microphone failed before answering ' + (e && e.name));
      audio = null;
      io.stop();
      problem = 'mic';
      signal.declineCall();
      emit();
    }
  );
}

/** Stop the ringtone and vibration and leave the call ringing, so it can still be answered. */
export function silenceRinging(): void {
  if (!state || state.phase !== 'incoming') return;
  silencedId = state.callId;
  tone.stop();
}

export function declineCall(): void {
  signal.declineCall();
}

export function hangUp(): void {
  signal.hangupCall();
}

export function toggleMute(): void {
  if (state) signal.setCallMuted(!state.muted);
}

/** Moves the call between the earpiece and the loudspeaker; before the call connects, it picks where it will start. */
export function toggleSpeaker(): void {
  speaker = !speaker;
  if (audio) audio.setSpeaker(speaker).catch((e) => dbg('call: speaker switch failed ' + (e && e.message)));
  if (tone.playing === 'ringback') tone.stop();
  syncTone(state);
  emit();
}

/** Clears an ended call from view. */
export function closeCall(): void {
  signal.dismissCall();
}

/** Signal-Desktop doesn't ring for a chat whose message request isn't accepted, or for someone it doesn't know. */
function ringsHere(peer: string): boolean {
  const conv = callConversation(peer);
  if (conv) return !conv.request;
  const c = contactByKey(peer);
  return !!c && c.whitelisted !== false;
}

function onState(s: CallState | null): void {
  const fresh = !!s && (!state || state.callId !== s.callId);
  state = s;
  if (fresh) {
    speaker = false;
    problem = null;
    answeringId = null;
    if (s!.direction === 'incoming' && s!.phase === 'incoming' && !ringsHere(s!.peer)) {
      dbg('call: not ringing for a message request');
      ignoredId = s!.callId;
      signal.ignoreCall();
      return;
    }
  }
  if (s && s.callId === ignoredId) {
    if (s.phase === 'ended') signal.dismissCall();
    return;
  }
  if (!s) ignoredId = null;
  syncTone(s);
  syncAudio(s);
  syncWake(s);
  emit();
}

function syncTone(s: CallState | null): void {
  const conv = s ? callConversation(s.peer) : undefined;
  const ringing = !!s && s.direction === 'incoming' && s.phase === 'incoming' && s.callId !== answeringId;
  if (ringing) {
    if (s!.callId !== silencedId && (!conv || shouldNotify(conv, { call: true }))) tone.start('ring', 'ringer', true);
    if (conv && document.hidden && notifiedConv !== conv.id) {
      notifyIncomingCall(conv);
      notifiedConv = conv.id;
    }
  } else if (s && s.direction === 'outgoing' && s.phase === 'ringing') {
    tone.start('ringback', speaker ? 'content' : 'telephony');
  } else {
    tone.stop();
  }
  if (!ringing && notifiedConv) {
    dismissNotifications(notifiedConv);
    notifiedConv = null;
  }
}

function syncAudio(s: CallState | null): void {
  const live = !!s && (s.phase === 'connected' || (s.direction === 'incoming' && (s.phase === 'connecting' || (s.phase === 'incoming' && s.callId === answeringId))));
  if (live && !audio) {
    const io = new CallAudioIO(signal);
    audio = io;
    io.start(speaker).catch((e) => {
      if (audio !== io) return;
      dbg('call: microphone or speaker failed ' + (e && e.name));
      audio = null;
      io.stop();
      problem = 'mic';
      signal.hangupCall();
      emit();
    });
  } else if (!live && audio) {
    audio.stop();
    audio = null;
  }
}

function requestWakeLock(topic: string): WakeLock | null {
  const b2g = (navigator as unknown as { b2g?: { requestWakeLock?(topic: string): WakeLock } }).b2g;
  try {
    return b2g && b2g.requestWakeLock ? b2g.requestWakeLock(topic) : null;
  } catch {
    return null;
  }
}

function hold(lock: WakeLock | null, want: boolean, topic: string): WakeLock | null {
  if (want) return lock || requestWakeLock(topic);
  if (lock) {
    try {
      lock.unlock();
    } catch {
      // already released
    }
  }
  return null;
}

/** The CPU stays awake for the whole call, and the screen while it rings. */
function syncWake(s: CallState | null): void {
  cpuLock = hold(cpuLock, !!s && s.phase !== 'ended', 'cpu');
  screenLock = hold(screenLock, !!s && s.phase === 'incoming', 'screen');
}

function emit(): void {
  for (const fn of Array.from(listeners)) fn();
}

export function _setCallStateForTest(s: CallState | null): void {
  onState(s);
}

export function _ringingForTest(): boolean {
  return tone.playing === 'ring';
}
