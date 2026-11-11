/* Archive, mute, pin, and marked-unread state, kept in step with Storage Service. */

import type { ChatStateEntry, PinnedChat } from '../../../engine/host';
import { signal } from '../api';
import { config } from '../config';
import { dbg } from '../log';
import type { Conversation } from '../types';
import { persistConv } from './conversations';
import { emit } from './events';
import { mentionsNotifyWhileMuted } from './notify';
import { convs } from './state';

export const MAX_PINNED_CHATS = 4;

/* Local archive, mute, and pin changes are published to Storage Service; changes that came from there go through applyChatState and never echo back. */
interface ChatStateFields {
  archived?: boolean;
  muted?: boolean;
  markedUnread?: boolean;
  pinned?: boolean;
  mentionsIfMuted?: boolean;
}

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
    if (s.muted !== undefined && !!conv.muted !== s.muted) {
      conv.muted = s.muted;
      changed[conv.id] = conv;
    }
    if (s.markedUnread !== undefined && !!conv.markedUnread !== s.markedUnread) {
      conv.markedUnread = s.markedUnread;
      changed[conv.id] = conv;
    }
    if (s.mentionsIfMuted !== undefined && conv.mentionsIfMuted !== (s.mentionsIfMuted === null ? undefined : s.mentionsIfMuted)) {
      if (s.mentionsIfMuted === null) delete conv.mentionsIfMuted;
      else conv.mentionsIfMuted = s.mentionsIfMuted;
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
  if (ids.length) emit('conversations');
}

/** New activity brings a chat out of the archive; muted chats stay archived unless the user turned that off, as in Signal. */
export function unarchiveOnActivity(conv: Conversation): void {
  if (!conv.archived || (config.keepMutedArchived() && conv.muted)) return;
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

type ChatFlag = 'archived' | 'muted' | 'markedUnread' | 'pinned';

function setChatFlag(convId: string, flag: ChatFlag, val: boolean): void {
  const conv = convs[convId];
  if (conv && !!conv[flag] !== val) changeChatState(conv, { [flag]: val });
}

export const setArchived = (convId: string, val: boolean): void => setChatFlag(convId, 'archived', val);
export const setMuted = (convId: string, val: boolean): void => setChatFlag(convId, 'muted', val);
/** Flag a chat as unread without touching its messages, as Signal's "Mark as unread". */
export const setMarkedUnread = (convId: string, val: boolean): void => setChatFlag(convId, 'markedUnread', val);

/** Whether mentions of us notify while this group is muted, kept on the account's other devices too. */
export function setMentionsIfMuted(convId: string, val: boolean): void {
  const conv = convs[convId];
  if (conv && conv.type === 'group' && mentionsNotifyWhileMuted(conv) !== val) changeChatState(conv, { mentionsIfMuted: val });
}

/** Pin a chat to the top of the list; false when Signal's limit is reached. */
export function setConvPinned(convId: string, val: boolean): boolean {
  const conv = convs[convId];
  if (!conv || !!conv.pinned === val) return true;
  if (val && Object.values(convs).filter((c) => c.pinned).length >= MAX_PINNED_CHATS) return false;
  setChatFlag(convId, 'pinned', val);
  return true;
}
