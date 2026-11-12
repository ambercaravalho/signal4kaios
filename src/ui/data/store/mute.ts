/* Timed mutes: a chat is muted until `mutedUntil`, and the chat list refreshes when one runs out. */

import type { Conversation } from '../types';
import { emit } from './events';
import { convs } from './state';

/** Signal's "Always", as Signal-Desktop stores it. Phones may store larger values, which also mean always. */
export const MUTED_ALWAYS = Number.MAX_SAFE_INTEGER;
const MAX_TIMER_MS = 0x7fffffff;

let timer: ReturnType<typeof setTimeout> | null = null;

export function isMuted(conv: Conversation, now = Date.now()): boolean {
  return (conv.mutedUntil || 0) > now;
}

export function mutedForever(conv: Conversation): boolean {
  return (conv.mutedUntil || 0) >= MUTED_ALWAYS;
}

/** Move a chat saved before timed mutes onto `mutedUntil`; true when it changed. */
export function migrateMute(conv: Conversation): boolean {
  if (conv.muted === undefined) return false;
  if (conv.muted && !conv.mutedUntil) conv.mutedUntil = MUTED_ALWAYS;
  delete conv.muted;
  return true;
}

/** Refresh the chat list once the next timed mute runs out. */
export function scheduleUnmute(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const now = Date.now();
  let next = 0;
  for (const k of Object.keys(convs)) {
    const until = convs[k].mutedUntil || 0;
    if (until > now && until < MUTED_ALWAYS && (!next || until < next)) next = until;
  }
  if (!next) return;
  timer = setTimeout(() => {
    timer = null;
    emit('conversations');
    scheduleUnmute();
  }, Math.min(next - now + 500, MAX_TIMER_MS));
}
