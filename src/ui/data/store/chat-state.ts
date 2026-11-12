/* Archive, mute, pin, and marked-unread state, kept in step with Storage Service. */

import type { ChatStateEntry, PinnedChat } from '../../../engine/host';
import { signal } from '../api';
import { config } from '../config';
import { dbg } from '../log';
import type { Conversation } from '../types';
import { persistConv } from './conversations';
import { emit } from './events';
import { isMuted, scheduleUnmute } from './mute';
import { type MutedException, notifiesWhileMuted } from './notify';
import { convs } from './state';

export const MAX_PINNED_CHATS = 4;

/* Local archive, mute, and pin changes are published to Storage Service; changes that came from there go through applyChatState and never echo back. */
interface ChatStateFields {
  archived?: boolean;
  mutedUntil?: number;
  markedUnread?: boolean;
  pinned?: boolean;
  mentionsIfMuted?: boolean;
  repliesIfMuted?: boolean;
  callsIfMuted?: boolean;
}

const EXCEPTION_FIELDS = ['mentionsIfMuted', 'repliesIfMuted', 'callsIfMuted'] as const;

export function syncChatState(conv: Conversation, fields: ChatStateFields): void {
  if (!conv.sendId) return;
  signal.syncChatState(Object.assign({ type: conv.type, sendId: conv.sendId }, fields)).catch((err) => dbg('chat state sync failed: ' + (err && err.message)));
}

function convForState(s: PinnedChat): Conversation | null {
  if (s.groupInternalId) return convs['g:' + s.groupInternalId] || null;
  return (s.uuid && convs[s.uuid]) || (s.number && convs[s.number]) || null;
}

export function applyChatState(states: ChatStateEntry[], pinned: PinnedChat[] | null): void {
  const changed: Record<string, Conversation> = {};
  for (const s of states || []) {
    const conv = convForState(s);
    if (!conv) continue;
    if (!!conv.archived !== s.archived) {
      conv.archived = s.archived;
      changed[conv.id] = conv;
    }
    if (s.mutedUntil !== undefined && (conv.mutedUntil || 0) !== s.mutedUntil) {
      conv.mutedUntil = s.mutedUntil;
      changed[conv.id] = conv;
    }
    if (s.markedUnread !== undefined && !!conv.markedUnread !== s.markedUnread) {
      conv.markedUnread = s.markedUnread;
      changed[conv.id] = conv;
    }
    for (const f of EXCEPTION_FIELDS) {
      const v = s[f];
      if (v === undefined || conv[f] === (v === null ? undefined : v)) continue;
      if (v === null) delete conv[f];
      else conv[f] = v;
      changed[conv.id] = conv;
    }
  }
  if (pinned) {
    const want: Record<string, true> = {};
    for (const p of pinned) {
      const conv = convForState(p);
      if (conv) want[conv.id] = true;
    }
    for (const k of Object.keys(convs)) {
      if (!!convs[k].pinned !== !!want[k]) {
        convs[k].pinned = !!want[k];
        changed[k] = convs[k];
      }
    }
  }
  const ids = Object.keys(changed);
  for (const k of ids) persistConv(changed[k]);
  if (ids.length) {
    emit('conversations');
    scheduleUnmute();
  }
}

/** New activity brings a chat out of the archive; muted chats stay archived unless the user turned that off, as in Signal. */
export function unarchiveOnActivity(conv: Conversation): void {
  if (!conv.archived || (config.keepMutedArchived() && isMuted(conv))) return;
  conv.archived = false;
  syncChatState(conv, { archived: false });
}

/** A local chat-state change: saved, shown, and published to our other devices. */
function changeChatState(conv: Conversation, fields: ChatStateFields): void {
  Object.assign(conv, fields);
  persistConv(conv);
  emit('conversations');
  syncChatState(conv, fields);
}

type ChatFlag = 'archived' | 'markedUnread' | 'pinned';

function setChatFlag(convId: string, flag: ChatFlag, val: boolean): void {
  const conv = convs[convId];
  if (conv && !!conv[flag] !== val) changeChatState(conv, { [flag]: val });
}

export const setArchived = (convId: string, val: boolean): void => setChatFlag(convId, 'archived', val);

/** Mute a chat until `until` (ms, or `MUTED_ALWAYS`); 0 unmutes. */
export function setMuted(convId: string, until: number): void {
  const conv = convs[convId];
  const val = until > Date.now() ? until : 0;
  if (!conv || (conv.mutedUntil || 0) === val) return;
  changeChatState(conv, { mutedUntil: val });
  scheduleUnmute();
}
/** Flag a chat as unread without touching its messages, as Signal's "Mark as unread". */
export const setMarkedUnread = (convId: string, val: boolean): void => setChatFlag(convId, 'markedUnread', val);

/** Whether mentions, replies to us, or calls notify while this chat is muted, kept on the account's other devices too. */
export function setNotifyIfMuted(convId: string, kind: MutedException, val: boolean): void {
  const conv = convs[convId];
  if (!conv || (kind !== 'calls' && conv.type !== 'group') || notifiesWhileMuted(conv, kind) === val) return;
  changeChatState(conv, { [kind + 'IfMuted']: val });
}

/** Pin a chat to the top of the list; false when Signal's limit is reached. */
export function setConvPinned(convId: string, val: boolean): boolean {
  const conv = convs[convId];
  if (!conv || !!conv.pinned === val) return true;
  if (val && Object.values(convs).filter((c) => c.pinned).length >= MAX_PINNED_CHATS) return false;
  setChatFlag(convId, 'pinned', val);
  return true;
}
