/* Row builders and actions shared by the settings screens. */

import { pick } from './Overlays';
import type { ActionRow } from './RowList';
import { toast } from './Toast';
import { EXPIRE_OPTIONS, fmtMsgTime } from '../data/format';
import * as store from '../data/store';
import type { Conversation } from '../data/types';
import { friendlyError } from '../errors';
import { S } from '../strings';

/** An on/off row; OK flips it. */
export function toggleRow(key: string, label: string, value: boolean, set: (v: boolean) => void, sub?: string): ActionRow {
  return { key, label, sub, end: 'toggle', checked: value, action: value ? S.turnOff : S.turnOn, onSelect: () => set(!value) };
}

/** Choose a disappearing-message timer; resolves undefined when cancelled. */
export function pickTimer(title: string, current: number): Promise<number | undefined> {
  return pick(title, EXPIRE_OPTIONS.map((o) => ({ value: o.secs, label: o.label })), current);
}

const HOUR = 3600000;
const MUTE_OPTIONS: Array<{ ms: number; label: string }> = [
  { ms: HOUR, label: S.mute1h },
  { ms: 8 * HOUR, label: S.mute8h },
  { ms: 24 * HOUR, label: S.mute1d },
  { ms: 7 * 24 * HOUR, label: S.mute7d },
  { ms: -1, label: S.muteAlways },
];

/** "Muted until 15:00", "Muted always", or "Off". */
export function muteLabel(conv: Conversation): string {
  if (!store.isMuted(conv)) return S.off;
  return store.mutedForever(conv) ? S.mutedAlways : S.mutedUntil.replace('{time}', fmtMsgTime(conv.mutedUntil || 0));
}

/** Unmute a muted chat, or ask how long to mute it for. */
export async function toggleMute(conv: Conversation): Promise<void> {
  if (store.isMuted(conv)) return store.setMuted(conv.id, 0);
  const ms = await pick(S.muteFor, MUTE_OPTIONS.map((o) => ({ value: o.ms, label: o.label })), HOUR);
  if (ms !== undefined) store.setMuted(conv.id, ms < 0 ? store.MUTED_ALWAYS : Date.now() + ms);
}

/** The Mute or Unmute item for a chat's options menu. */
export function muteItem(conv: Conversation): { label: string; onSelect(): void } {
  return { label: store.isMuted(conv) ? S.unmute : S.muteNotifications, onSelect: () => toggleMute(conv) };
}

/** Run a change, toast the outcome, and on success run `after`. */
export function runAction(p: Promise<unknown>, done: string, after?: () => void): Promise<void> {
  return p.then(
    () => {
      toast(done);
      if (after) after();
    },
    (e) => toast(friendlyError(e))
  );
}
