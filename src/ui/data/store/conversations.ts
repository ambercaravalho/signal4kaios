/* Chats: creating, listing, loading at start-up, and expiring their messages. */

import { config } from '../config';
import { db, type ExpiredRef } from '../db';
import { dbg } from '../log';
import type { ChatRef, MessageEvent } from '../normalize';
import type { PickedMention } from '../styled';
import type { Attachment, Connection, Conversation, Message } from '../types';
import { altKeyOf, contactByKey, directName, displayName, isSelfKey, refreshDirectory, self } from './contacts';
import { emit } from './events';
import { applyNotice, ingestRaw } from './ingest';
import { contactsByKey, convs, state, typingMap } from './state';

export function msgId(convId: string, ts: number, author: string): string {
  return convId + '|' + ts + '|' + author;
}

export function persistConv(conv: Conversation): void {
  db.putConversation(conv).catch((e) => dbg('save chat failed: ' + (e && e.message)));
}

function newConv(id: string, type: 'direct' | 'group', name: string, sendId: string | null, groupInternalId?: string): Conversation {
  const c: Conversation = { id, type, sendId, name, lastTs: 0, lastPreview: '', unread: 0, lastReadTs: 0 };
  if (groupInternalId) c.groupInternalId = groupInternalId;
  return c;
}

export function ensureConv(ev: Pick<MessageEvent, 'convId' | 'groupInternalId' | 'incoming' | 'authorName'>): Conversation {
  let conv = convs[ev.convId];
  if (conv) return conv;
  if (ev.groupInternalId) {
    const g = state.groupsByInternal[ev.groupInternalId];
    conv = newConv(ev.convId, 'group', g ? g.name : 'Group', g ? g.id : null, ev.groupInternalId);
    if (!g) refreshDirectory().catch(() => {});
  } else {
    const known = displayName(ev.convId);
    const name = known === ev.convId && ev.incoming && ev.authorName ? ev.authorName : known;
    conv = newConv(ev.convId, 'direct', directName(ev.convId, name), ev.convId);
    if (ev.incoming && !isSelfKey(ev.convId)) {
      const c = contactByKey(ev.convId);
      if (!c || c.whitelisted === false) conv.request = true;
    }
  }
  convs[conv.id] = conv;
  return conv;
}

const MEDIA_PAGE = 200;

/** A chat's attachments that can be opened again, newest first; view-once media and files sent from this phone are left out. */
export async function chatMedia(convId: string, limit: number = 300): Promise<Array<{ msg: Message; att: Attachment }>> {
  const out: Array<{ msg: Message; att: Attachment }> = [];
  let before = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const page = await db.getMessagesPage(convId, before, MEDIA_PAGE);
    for (let i = page.length - 1; i >= 0; i--) {
      const m = page[i];
      if (m.deleted || !m.attachments) continue;
      for (const att of m.attachments) {
        if (!att.id || att.viewOnce) continue;
        out.push({ msg: m, att });
        if (out.length >= limit) return out;
      }
    }
    if (page.length < MEDIA_PAGE) return out;
    before = page[0].timestamp;
  }
}

export function emitRemovals(removed: ExpiredRef[]): void {
  for (const r of removed || []) emit('message-removed', r);
  if (removed && removed.length) emit('conversations');
}

export function purgeExpired(): Promise<void> {
  return db
    .deleteExpired(Date.now())
    .then(emitRemovals)
    .catch((e) => dbg('purge expired failed: ' + (e && e.message)));
}

export function purgeExpiredConv(convId: string): Promise<void> {
  return db
    .deleteExpiredIn(convId, Date.now())
    .then(emitRemovals)
    .catch((e) => dbg('purge chat expired failed: ' + (e && e.message)));
}

/** Keep (or clear) a chat's unsent composer text. */
export function setDraft(convId: string, text: string, mentions: PickedMention[]): void {
  const conv = convs[convId];
  if (!conv) return;
  const draft = text.trim() ? text : '';
  if ((conv.draft || '') === draft) return;
  if (draft) {
    conv.draft = draft;
    conv.draftMentions = mentions.length ? mentions : undefined;
  } else {
    delete conv.draft;
    delete conv.draftMentions;
  }
  persistConv(conv);
  emit('conversations');
}

export async function removeChat(conv: Conversation): Promise<void> {
  delete convs[conv.id];
  delete typingMap[conv.id];
  await db.pruneConversation(conv.id, 0);
  await db.deleteConversation(conv.id);
  emit('conversations');
}

export function chatFor(ref: ChatRef): Conversation | undefined {
  const alt = altKeyOf(ref.key);
  return convs[ref.key] || (alt ? convs[alt] : undefined);
}

/** Remember the chat's disappearing-message timer locally; the caller changes it on Signal's side. */
export function setConvExpire(convId: string, secs: number): void {
  const conv = convs[convId];
  if (!conv) return;
  const changed = (conv.expireTimer || 0) !== (secs || 0);
  conv.expireTimer = secs || 0;
  persistConv(conv);
  emit('conversations');
  if (changed && conv.type === 'direct') timerLine(conv, self(), secs || 0, Date.now());
}

/** A 1:1 chat's timer line; a group's comes with its other changes. */
export function timerLine(conv: Conversation, author: string, seconds: number, timestamp: number): void {
  applyNotice({ type: 'notice', convId: conv.id, groupInternalId: null, author, timestamp, notice: { kind: 'timer', seconds } }, true);
}

export function setConversationName(convId: string, name: string): void {
  const conv = convs[convId];
  if (!conv || !name) return;
  conv.name = name;
  persistConv(conv);
  emit('conversations');
}

/** The direct chat with a contact, created empty if needed. */
export function conversationWith(contact: { number?: string; uuid?: string; name?: string }): Conversation {
  const convId = contact.number || contact.uuid || '';
  let conv = convs[convId];
  if (!conv) {
    conv = newConv(convId, 'direct', directName(convId, contact.name || convId), convId);
    convs[convId] = conv;
    persistConv(conv);
    emit('conversations');
  }
  return conv;
}

export function groupConversation(internalId: string): Conversation {
  const convId = 'g:' + internalId;
  let conv = convs[convId];
  if (!conv) {
    const g = state.groupsByInternal[internalId];
    conv = newConv(convId, 'group', g ? g.name : 'Group', g ? g.id : null, internalId);
    convs[convId] = conv;
    persistConv(conv);
    emit('conversations');
  }
  return conv;
}

/** The chat for a group we just joined through its link, starting with a "You joined" line. */
export function joinedGroupConversation(internalId: string, name: string): Conversation {
  const conv = groupConversation(internalId);
  if (name && conv.name !== name) {
    conv.name = name;
    persistConv(conv);
  }
  const aci = config.aci();
  if (aci) ingestRaw({ envelope: { groupUpdate: { groupId: internalId, author: aci, timestamp: Date.now(), changes: [{ change: 'joinedViaLink', target: aci }] } } });
  return conv;
}

export async function init(): Promise<void> {
  try {
    for (const c of await db.allContacts()) {
      if (c.number) contactsByKey[c.number] = c;
      if (c.uuid) contactsByKey[c.uuid] = c;
    }
    const groups = await db.kvGet('groups');
    state.groupsByInternal = groups && typeof groups === 'object' ? (groups as typeof state.groupsByInternal) : {};
    for (const c of await db.allConversations()) convs[c.id] = c;
    state.ready = true;
    emit('conversations');
    purgeExpired();
    if (!state.purgeTimer) state.purgeTimer = setInterval(purgeExpired, 30000);
    if (config.isConfigured()) refreshDirectory().catch((e) => dbg('directory refresh failed: ' + (e && e.message)));
  } catch (e: any) {
    state.ready = true;
    emit('conversations');
    dbg('store init failed: ' + (e && e.message));
    emit('storage-error', String((e && e.message) || e));
  }
}

function sortedByRecent(list: Conversation[]): Conversation[] {
  return list.sort((a, b) => b.lastTs - a.lastTs);
}

/** Chats with messages, pinned first, newest first. */
export function conversations(): Conversation[] {
  return Object.values(convs)
    .filter((c) => c.lastTs > 0 && !c.archived)
    .sort((a, b) => (!!a.pinned !== !!b.pinned ? (a.pinned ? -1 : 1) : b.lastTs - a.lastTs));
}

export function archivedConversations(): Conversation[] {
  return sortedByRecent(Object.values(convs).filter((c) => c.lastTs > 0 && !!c.archived));
}

export function conversation(id: string): Conversation | undefined {
  return convs[id];
}

export function typing(convId: string): { author: string; until: number } | null {
  const t = typingMap[convId];
  return t && t.until > Date.now() ? t : null;
}

export function setOpenConv(convId: string | null): void {
  state.openConvId = convId;
}

export function openConversationId(): string | null {
  return state.openConvId;
}

export function setConnection(s: Connection): void {
  state.connection = s;
  emit('connection', s);
}

export function connectionState(): Connection {
  return state.connection;
}

export function isReady(): boolean {
  return state.ready;
}
