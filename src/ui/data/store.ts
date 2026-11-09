/* App state and its event hub. Flow: WebSocket frame, then `parseFrame`, then `applyEvent`, then IndexedDB, then an event screens subscribe to. */

import type { ChatStateEntry, PinnedChat } from '../../engine/host';
import { signal, syncedContacts, syncedGroups, type SyncedContact } from './api';
import { config } from './config';
import { db, type ExpiredRef } from './db';
import { dbg } from './log';
import { fmt, S } from '../strings';
import { parseFrame, type MessageEvent, type NoticeEvent, type StoreEvent } from './normalize';
import { hasServiceWorker } from './platform';
import { encodeMentions, parseStyledMarkdown, type PickedMention, type StyleRange } from './styled';
import type { Attachment, Connection, Contact, Conversation, GroupRef, Message, Notice, Quote } from './types';

export interface StoreEvents {
  conversations: [];
  message: [Message];
  'message-updated': [Message, string | undefined];
  'message-removed': [ExpiredRef];
  typing: [string];
  connection: [Connection];
  'storage-error': [string];
}

type Listener<K extends keyof StoreEvents> = (...args: StoreEvents[K]) => void;

const listeners: { [K in keyof StoreEvents]?: Array<Listener<K>> } = {};
const contactsByKey: Record<string, Contact> = {};
let groupsByInternal: Record<string, { id: string; name: string }> = {};
const convs: Record<string, Conversation> = {};
const typingMap: Record<string, { author: string; until: number }> = {};
let openConvId: string | null = null;
let connection: Connection = 'closed';
let ready = false;
let purgeTimer: ReturnType<typeof setInterval> | null = null;
let notificationClick: ((convId: string) => void) | null = null;

const STATUS_RANK: Record<string, number> = { pending: 0, failed: 0, sent: 1, delivered: 2, read: 3 };
export const SELF_NAME = 'Note to Self';
export const MAX_PINNED_CHATS = 4;

export function on<K extends keyof StoreEvents>(evt: K, fn: Listener<K>): () => void {
  const arr = (listeners[evt] = listeners[evt] || []) as Array<Listener<K>>;
  arr.push(fn);
  return () => {
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  };
}

function emit<K extends keyof StoreEvents>(evt: K, ...args: StoreEvents[K]): void {
  for (const fn of ((listeners[evt] || []) as Array<Listener<K>>).slice()) {
    try {
      fn(...args);
    } catch (e: any) {
      dbg('listener error [' + evt + '] ' + (e && e.message));
    }
  }
}

function self(): string {
  return config.number();
}

function isSelfKey(key: string): boolean {
  const n = config.number();
  if (!key || !n) return false;
  if (key === n) return true;
  const c = contactsByKey[key];
  return !!(c && c.number && c.number === n);
}

export function isSelfConv(conv: Pick<Conversation, 'id' | 'type'> | undefined | null): boolean {
  return !!(conv && conv.type !== 'group' && isSelfKey(conv.id));
}

function msgId(convId: string, ts: number, author: string): string {
  return convId + '|' + ts + '|' + author;
}

export function contactByKey(key: string): Contact | undefined {
  return key ? contactsByKey[key] : undefined;
}

/** A person's name for message authors and member lists; never "Note to Self". */
export function displayName(key: string): string {
  const c = contactByKey(key);
  if (c && c.name && c.name !== SELF_NAME) return c.name;
  return key || '?';
}

function directName(key: string, fallback: string): string {
  return isSelfKey(key) ? SELF_NAME : fallback;
}

function altKeyOf(key: string): string | null {
  const c = contactByKey(key);
  if (!c) return null;
  if (c.number && c.number !== key) return c.number;
  if (c.uuid && c.uuid !== key) return c.uuid;
  return null;
}

function persistConv(conv: Conversation): void {
  db.putConversation(conv).catch((e) => dbg('save chat failed: ' + (e && e.message)));
}

function newConv(id: string, type: 'direct' | 'group', name: string, sendId: string | null, groupInternalId?: string): Conversation {
  const c: Conversation = { id, type, sendId, name, lastTs: 0, lastPreview: '', unread: 0, lastReadTs: 0 };
  if (groupInternalId) c.groupInternalId = groupInternalId;
  return c;
}

function ensureConv(ev: Pick<MessageEvent, 'convId' | 'groupInternalId' | 'incoming' | 'authorName'>): Conversation {
  let conv = convs[ev.convId];
  if (conv) return conv;
  if (ev.groupInternalId) {
    const g = groupsByInternal[ev.groupInternalId];
    conv = newConv(ev.convId, 'group', g ? g.name : 'Group', g ? g.id : null, ev.groupInternalId);
    if (!g) refreshDirectory().catch(() => {});
  } else {
    const known = displayName(ev.convId);
    const name = known === ev.convId && ev.incoming && ev.authorName ? ev.authorName : known;
    conv = newConv(ev.convId, 'direct', directName(ev.convId, name), ev.convId);
  }
  convs[conv.id] = conv;
  return conv;
}

/** The chat-list preview for a message with no text. */
export function attachmentLabel(attachments: Array<Partial<Attachment>> | undefined): string {
  if (!attachments || !attachments.length) return '';
  const a = attachments[0];
  const type = a.contentType || '';
  if (a.viewOnce) return 'View-once media';
  if (a.voiceNote || type.indexOf('audio/') === 0) return 'Voice message';
  if (type.indexOf('image/') === 0) return 'Photo';
  if (type.indexOf('video/') === 0) return 'Video';
  return a.filename || 'File';
}

function previewOf(body: string, attachments: Attachment[]): string {
  return body || attachmentLabel(attachments);
}

/** What a notice line says; `author` is who it's about. */
export function noticeText(notice: Notice, author: string): string {
  switch (notice.kind) {
    case 'missedCall':
      return notice.video ? S.missedVideoCall : S.missedVoiceCall;
    case 'safetyNumber':
      return fmt(S.safetyNumberChanged, { name: displayName(author) });
    case 'groupCall':
      return author && !isSelfKey(author) ? fmt(S.startedGroupCall, { name: displayName(author) }) : S.groupCall;
  }
}

function messageText(rec: Message): string {
  return rec.notice ? noticeText(rec.notice, rec.author) : previewOf(rec.body, rec.attachments);
}

export function onNotificationClick(fn: (convId: string) => void): void {
  notificationClick = fn;
}

function notify(conv: Conversation, rec: Message): void {
  if (conv.muted || !document.hidden || typeof Notification === 'undefined') return;
  const title = conv.name || 'Beacon';
  let body = messageText(rec) || 'New message';
  if (conv.type === 'group' && !rec.notice) body = displayName(rec.author) + ': ' + body;
  const opts: NotificationOptions = { body: body.slice(0, 100), tag: conv.id, icon: '/assets/icons/kaios_112.png', data: { convId: conv.id } };

  if (hasServiceWorker() && navigator.serviceWorker) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, opts)).catch((e) => dbg('notify (sw) failed ' + (e && e.message)));
    return;
  }
  try {
    const n = new Notification(title, opts);
    n.onclick = () => {
      window.focus();
      if (notificationClick) notificationClick(conv.id);
      n.close();
    };
  } catch (e: any) {
    dbg('notify failed ' + (e && e.message));
  }
}

function applyMessage(ev: MessageEvent, silent: boolean): void {
  const conv = ensureConv(ev);
  const rec: Message = {
    id: msgId(ev.convId, ev.timestamp, ev.author),
    convId: ev.convId,
    incoming: ev.incoming,
    author: ev.author,
    authorName: ev.authorName || '',
    timestamp: ev.timestamp,
    body: ev.body || '',
    styles: ev.styles || [],
    quote: ev.quote || null,
    attachments: ev.attachments || [],
    reactions: {},
    status: ev.incoming ? 'received' : 'sent',
    deleted: false,
    edited: false,
  };
  if (ev.expiresInSeconds) {
    rec.expireSecs = ev.expiresInSeconds;
    rec.expiresAt = Date.now() + ev.expiresInSeconds * 1000;
  }
  if ((conv.expireTimer || 0) !== ev.expiresInSeconds) conv.expireTimer = ev.expiresInSeconds;
  db.putMessage(rec);

  conv.lastTs = Math.max(conv.lastTs || 0, ev.timestamp);
  conv.lastPreview = previewOf(rec.body, rec.attachments);
  unarchiveOnActivity(conv);
  if (ev.incoming && openConvId !== conv.id) conv.unread = (conv.unread || 0) + 1;
  if (typingMap[conv.id]) {
    delete typingMap[conv.id];
    emit('typing', conv.id);
  }
  persistConv(conv);

  emit('message', rec);
  emit('conversations');
  // Draining the offline queue (silent) must not notify per message: the queue replays on every reconnect.
  if (ev.incoming && !silent) notify(conv, rec);
  if (ev.incoming && openConvId === conv.id) markRead(conv.id);
}

/** Missed calls count as unread and notify, as in Signal; other notices only show in the chat. */
function applyNotice(ev: NoticeEvent, silent: boolean): void {
  const conv = ensureConv({ convId: ev.convId, groupInternalId: ev.groupInternalId, incoming: true, authorName: '' });
  const rec: Message = {
    id: msgId(ev.convId, ev.timestamp, ev.author),
    convId: ev.convId,
    incoming: true,
    author: ev.author,
    authorName: '',
    timestamp: ev.timestamp,
    body: '',
    styles: [],
    quote: null,
    attachments: [],
    reactions: {},
    status: 'received',
    deleted: false,
    edited: false,
    notice: ev.notice,
  };
  db.putMessage(rec);
  const alerts = ev.notice.kind === 'missedCall';
  if (ev.timestamp >= (conv.lastTs || 0)) {
    conv.lastTs = ev.timestamp;
    conv.lastPreview = messageText(rec);
  }
  if (alerts) {
    unarchiveOnActivity(conv);
    if (openConvId !== conv.id) conv.unread = (conv.unread || 0) + 1;
  }
  persistConv(conv);
  emit('message', rec);
  emit('conversations');
  if (alerts && !silent) notify(conv, rec);
}

/* Read-modify-write updates to stored messages run through one queue so, e.g., a reaction and a receipt arriving together don't clobber each other. */
let mutations: Promise<unknown> = Promise.resolve();
function enqueueMutation(fn: () => Promise<unknown>): Promise<unknown> {
  mutations = mutations.then(fn).catch((e) => dbg('update failed: ' + (e && e.message)));
  return mutations;
}

async function findMessage(convId: string, ts: number, authors: Array<string | null>): Promise<Message | undefined> {
  const ids: string[] = [];
  for (const a of authors) if (a && ids.indexOf(msgId(convId, ts, a)) < 0) ids.push(msgId(convId, ts, a));
  for (const id of ids) {
    const found = await db.getMessage(id);
    if (found) return found;
  }
  return undefined;
}

function updateTarget(convId: string, ts: number, authors: Array<string | null>, what: string, change: (rec: Message) => void): void {
  enqueueMutation(async () => {
    const rec = await findMessage(convId, ts, authors);
    if (!rec) {
      dbg(what + ' target not found');
      return;
    }
    change(rec);
    emit('message-updated', rec, undefined);
    await db.putMessage(rec);
  });
}

function setPreviewIfLast(convId: string, rec: Message, preview: string): void {
  const conv = convs[convId];
  if (conv && conv.lastTs === rec.timestamp) {
    conv.lastPreview = preview;
    persistConv(conv);
    emit('conversations');
  }
}

function applyTyping(convId: string, author: string, started: boolean): void {
  // As in Signal, turning off your own typing indicators hides other people's too.
  if (started && !config.typingIndicators()) return;
  if (started) {
    typingMap[convId] = { author, until: Date.now() + 15000 };
    setTimeout(() => {
      const t = typingMap[convId];
      if (t && t.until <= Date.now()) {
        delete typingMap[convId];
        emit('typing', convId);
      }
    }, 15500);
  } else {
    delete typingMap[convId];
  }
  emit('typing', convId);
}

function applyReceipt(peer: string, kind: string, timestamps: number[]): void {
  if (kind !== 'read' && kind !== 'delivery') return;
  const alt = altKeyOf(peer);
  for (const ts of timestamps) {
    // Group receipts come from members but reference our sent timestamp in the group chat.
    const candidates = [peer, alt].concat(Object.keys(convs).filter((cid) => convs[cid].type === 'group'));
    enqueueMutation(async () => {
      let rec: Message | undefined;
      for (const cid of candidates) {
        if (!cid) continue;
        rec = await db.getMessage(msgId(cid, ts, self()));
        if (rec) break;
      }
      if (!rec) return;
      // As in Signal, turning off your own read receipts hides other people's too.
      const next = kind === 'read' && config.sendReadReceipts() ? 'read' : 'delivered';
      if ((STATUS_RANK[next] || 0) > (STATUS_RANK[rec.status] || 0)) {
        rec.status = next;
        emit('message-updated', rec, undefined);
        await db.putMessage(rec);
      }
    });
  }
}

function applyReadSync(entries: Array<{ sender: string; timestamp: number }>): void {
  let changed = false;
  for (const entry of entries) {
    for (const cid of [entry.sender, altKeyOf(entry.sender)]) {
      const conv = cid ? convs[cid] : null;
      if (!conv) continue;
      if (conv.unread > 0) {
        conv.unread = 0;
        changed = true;
      }
      if (entry.timestamp > (conv.lastReadTs || 0)) conv.lastReadTs = entry.timestamp;
      persistConv(conv);
    }
  }
  if (changed) emit('conversations');
}

export function applyEvent(ev: StoreEvent, silent: boolean): void {
  switch (ev.type) {
    case 'message':
      return applyMessage(ev, silent);
    case 'notice':
      return applyNotice(ev, silent);
    case 'reaction':
      return updateTarget(ev.convId, ev.targetTimestamp, [ev.targetAuthor, altKeyOf(ev.targetAuthor), self()], 'reaction', (rec) => {
        rec.reactions = rec.reactions || {};
        if (ev.remove) delete rec.reactions[ev.reactor];
        else rec.reactions[ev.reactor] = ev.emoji;
      });
    case 'remoteDelete':
      return updateTarget(ev.convId, ev.targetTimestamp, [ev.author, altKeyOf(ev.author)], 'delete', (rec) => {
        rec.deleted = true;
        rec.body = '';
        setPreviewIfLast(ev.convId, rec, 'This message was deleted.');
      });
    case 'edit':
      return updateTarget(ev.convId, ev.targetTimestamp, [ev.author, altKeyOf(ev.author), self()], 'edit', (rec) => {
        rec.body = ev.newBody;
        rec.styles = ev.newStyles || [];
        rec.edited = true;
        setPreviewIfLast(ev.convId, rec, ev.newBody);
      });
    case 'pin':
    case 'unpin':
      return updateTarget(ev.convId, ev.targetTimestamp, [ev.targetAuthor, altKeyOf(ev.targetAuthor), self()], 'pin', (rec) => {
        rec.pinned = ev.type === 'pin';
      });
    case 'typing':
      return applyTyping(ev.convId, ev.author, ev.started);
    case 'receipt':
      return applyReceipt(ev.peer, ev.kind, ev.timestamps);
    case 'readSync':
      return applyReadSync(ev.entries);
    case 'timer': {
      const conv = convs[ev.convId];
      if (!conv || (conv.expireTimer || 0) === ev.seconds) return;
      conv.expireTimer = ev.seconds;
      persistConv(conv);
      emit('conversations');
      return;
    }
  }
}

/** Apply one decrypted frame. `silent` while draining the offline queue, so queued messages don't each notify. */
export function ingestRaw(frame: unknown, opts?: { silent?: boolean }): void {
  for (const ev of parseFrame(frame, self(), displayName)) applyEvent(ev, !!(opts && opts.silent));
}

/** The best name across the places Signal keeps names: nickname or address book, profile, username, then number. */
export function contactName(c: SyncedContact): string {
  if (c.name && c.name !== SELF_NAME) return c.name;
  const nick = c.nickname || {};
  if (nick.name) return nick.name;
  const nn = [nick.given_name, nick.family_name].filter(Boolean).join(' ');
  if (nn) return nn;
  if (c.profile_name) return c.profile_name;
  const p = c.profile || {};
  const pn = [p.given_name, p.lastname].filter(Boolean).join(' ');
  if (pn) return pn;
  return c.username || c.number || c.uuid;
}

export async function refreshDirectory(): Promise<boolean> {
  if (!config.isConfigured()) return false;
  const [contacts, groups] = await Promise.all([syncedContacts(), syncedGroups()]);
  const records: Contact[] = [];
  for (const c of contacts) {
    const rec: Contact = { id: c.uuid || c.number, number: c.number || '', uuid: c.uuid || '', name: contactName(c), blocked: !!c.blocked, hasAvatar: c.profile ? !!c.profile.has_avatar : undefined };
    if (!rec.id) continue;
    records.push(rec);
    if (rec.number) contactsByKey[rec.number] = rec;
    if (rec.uuid) contactsByKey[rec.uuid] = rec;
  }
  db.putContacts(records);

  groupsByInternal = {};
  for (const g of groups) if (g.internal_id) groupsByInternal[g.internal_id] = { id: g.id, name: g.name || 'Group' };
  db.kvSet('groups', groupsByInternal);

  let changed = false;
  for (const conv of Object.values(convs)) {
    if (conv.type === 'group') {
      const g = conv.groupInternalId ? groupsByInternal[conv.groupInternalId] : undefined;
      if (g && (conv.name !== g.name || conv.sendId !== g.id)) {
        conv.name = g.name;
        conv.sendId = g.id;
        persistConv(conv);
        changed = true;
      }
    } else {
      const name = directName(conv.id, displayName(conv.id));
      if (name !== conv.id && name !== conv.name) {
        conv.name = name;
        persistConv(conv);
        changed = true;
      }
    }
  }
  emit('conversations');
  dbg('directory refreshed: ' + records.length + ' contacts, ' + groups.length + ' groups');
  return changed;
}

type SendPayload = Parameters<typeof signal.send>[0];

function sendCore(conv: Conversation, rec: Message, payload: SendPayload, preview: string): Promise<Message> {
  db.putMessage(rec);
  conv.lastTs = rec.timestamp;
  conv.lastPreview = preview;
  unarchiveOnActivity(conv);
  persistConv(conv);
  emit('message', rec);
  emit('conversations');

  const ts = rec.timestamp;
  return signal.send(payload).then(
    (res: any) => {
      const newTs = res && res.timestamp ? parseInt(res.timestamp, 10) : ts;
      const oldId = rec.id;
      if (newTs && newTs !== ts) {
        db.deleteMessage(oldId);
        rec.timestamp = newTs;
        rec.id = msgId(conv.id, newTs, self());
        conv.lastTs = Math.max(conv.lastTs, newTs);
        persistConv(conv);
      }
      rec.status = 'sent';
      db.putMessage(rec);
      emit('message-updated', rec, oldId);
      return rec;
    },
    (err: any) => {
      rec.status = 'failed';
      db.putMessage(rec);
      emit('message-updated', rec, undefined);
      dbg('send failed: ' + (err && err.message));
      throw err;
    }
  );
}

function newOutgoingRec(conv: Conversation, extras: Partial<Message>): Message {
  const ts = Date.now();
  const base: Message = {
    id: msgId(conv.id, ts, self()),
    convId: conv.id,
    incoming: false,
    author: self(),
    authorName: '',
    timestamp: ts,
    body: '',
    styles: [],
    quote: null,
    attachments: [],
    reactions: {},
    status: 'pending',
    deleted: false,
    edited: false,
  };
  if (conv.expireTimer) {
    base.expireSecs = conv.expireTimer;
    base.expiresAt = ts + conv.expireTimer * 1000;
  }
  return Object.assign(base, extras);
}

function emitRemovals(removed: ExpiredRef[]): void {
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

function convForSend(convId: string): Conversation {
  const conv = convs[convId];
  if (!conv) throw new Error('unknown chat');
  if (!conv.sendId) throw new Error('group not ready');
  return conv;
}

/** With styled text on, typed markers become formatting locally and in what's sent. */
function styled(text: string): { body: string; styles: StyleRange[] } {
  if (config.styledText() && text) return parseStyledMarkdown(text);
  return { body: text || '', styles: [] };
}

export function sendText(convId: string, text: string, quote?: Quote | null, mentions: PickedMention[] = []): Promise<Message> {
  let conv: Conversation;
  try {
    conv = convForSend(convId);
  } catch (e) {
    return Promise.reject(e);
  }
  const st = styled(text);
  const wire = encodeMentions(st.body, st.styles, mentions);
  const rec = newOutgoingRec(conv, { body: st.body, styles: st.styles, raw: text, quote: quote || null });
  if (wire.mentions.length) rec.mentions = mentions;
  const payload: SendPayload = { recipients: [conv.sendId!], message: wire.body, styles: wire.styles, mentions: wire.mentions, expire_timer: conv.expireTimer || 0 };
  if (quote) {
    payload.quote_timestamp = quote.timestamp;
    payload.quote_author = quote.author;
    payload.quote_message = quote.text;
    if (quote.attachments && quote.attachments.length) payload.quote_attachments = quote.attachments;
  }
  return sendCore(conv, rec, payload, st.body);
}

/** `dataUri` is "data:<mime>;base64,…" (a scaled photo, a picked file, or a voice note). */
export function sendAttachment(convId: string, dataUri: string, caption: string, meta: { contentType?: string; filename?: string; size?: number; voiceNote?: boolean } = {}): Promise<Message> {
  let conv: Conversation;
  try {
    conv = convForSend(convId);
  } catch (e) {
    return Promise.reject(e);
  }
  const contentType = meta.contentType || 'image/jpeg';
  const filename = meta.filename || 'photo.jpg';
  const att: Attachment = { id: '', contentType, filename, size: meta.size || 0, voiceNote: !!meta.voiceNote };
  const st = styled(caption || '');
  const rec = newOutgoingRec(conv, { body: st.body, styles: st.styles, raw: caption || '', attachments: [att] });
  const payload: SendPayload = { recipients: [conv.sendId!], message: st.body, styles: st.styles, expire_timer: conv.expireTimer || 0, base64_attachments: [dataUri] };
  return sendCore(conv, rec, payload, st.body || attachmentLabel([att]));
}

export function sendEdit(rec: Message, newText: string, mentions: PickedMention[] = []): Promise<Message> {
  let conv: Conversation;
  try {
    conv = convForSend(rec.convId);
  } catch (e) {
    return Promise.reject(e);
  }
  const st = styled(newText);
  const wire = encodeMentions(st.body, st.styles, mentions);
  return signal.send({ recipients: [conv.sendId!], message: wire.body, styles: wire.styles, mentions: wire.mentions, expire_timer: conv.expireTimer || 0, edit_timestamp: rec.timestamp }).then(() => {
    rec.body = st.body;
    rec.styles = st.styles;
    rec.raw = newText;
    rec.mentions = wire.mentions.length ? mentions : undefined;
    rec.edited = true;
    db.putMessage(rec);
    emit('message-updated', rec, undefined);
    setPreviewIfLast(conv.id, rec, st.body);
    return rec;
  });
}

export function retryMessage(rec: Message): Promise<Message> {
  db.deleteMessage(rec.id);
  emit('message-removed', { id: rec.id, convId: rec.convId, timestamp: rec.timestamp });
  return sendText(rec.convId, rec.raw != null ? rec.raw : rec.body, rec.quote, rec.mentions || []);
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

/** Delete a message from this phone only. */
export function deleteLocal(rec: Message): Promise<void> {
  emit('message-removed', { id: rec.id, convId: rec.convId, timestamp: rec.timestamp });
  return db.deleteMessage(rec.id);
}

export function reactTo(rec: Message, emoji: string | null): Promise<void> {
  const conv = convs[rec.convId];
  if (!conv || !conv.sendId) return Promise.reject(new Error('group not ready'));
  const me = self();
  const target = rec.incoming ? rec.author : me;
  rec.reactions = rec.reactions || {};
  const prev = rec.reactions[me] || null;
  if (emoji) rec.reactions[me] = emoji;
  else delete rec.reactions[me];
  db.putMessage(rec);
  emit('message-updated', rec, undefined);
  return signal.sendReaction(conv.sendId, target, rec.timestamp, emoji || prev || '', !emoji).catch((err) => {
    if (prev) rec.reactions[me] = prev;
    else delete rec.reactions[me];
    db.putMessage(rec);
    emit('message-updated', rec, undefined);
    throw err;
  });
}

export function deleteForEveryone(rec: Message): Promise<void> {
  const conv = convs[rec.convId];
  if (!conv || !conv.sendId) return Promise.reject(new Error('group not ready'));
  return signal.sendRemoteDelete(conv.sendId, rec.timestamp).then(() => {
    rec.deleted = true;
    rec.body = '';
    db.putMessage(rec);
    emit('message-updated', rec, undefined);
  });
}

/** Pin or unpin a message for everyone in the chat; reverts if sending fails. */
export function setMessagePinned(rec: Message, pinned: boolean): Promise<void> {
  const conv = convs[rec.convId];
  if (!conv || !conv.sendId) return Promise.reject(new Error('group not ready'));
  const target = rec.incoming ? rec.author : self();
  rec.pinned = pinned;
  db.putMessage(rec);
  emit('message-updated', rec, undefined);
  return signal.sendPin(conv.sendId, target, rec.timestamp, pinned).catch((err) => {
    rec.pinned = !pinned;
    db.putMessage(rec);
    emit('message-updated', rec, undefined);
    throw err;
  });
}

/* Local archive, mute, and pin changes are published to Storage Service; changes that came from there go through applyChatState and never echo back. */
function syncChatState(conv: Conversation, fields: { archived?: boolean; muted?: boolean; pinned?: boolean }): void {
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
function unarchiveOnActivity(conv: Conversation): void {
  if (!conv.archived || (config.keepMutedArchived() && conv.muted)) return;
  conv.archived = false;
  syncChatState(conv, { archived: false });
}

export function setArchived(convId: string, val: boolean): void {
  const conv = convs[convId];
  if (!conv || !!conv.archived === val) return;
  conv.archived = val;
  persistConv(conv);
  emit('conversations');
  syncChatState(conv, { archived: val });
}

export function setMuted(convId: string, val: boolean): void {
  const conv = convs[convId];
  if (!conv || !!conv.muted === val) return;
  conv.muted = val;
  persistConv(conv);
  emit('conversations');
  syncChatState(conv, { muted: val });
}

/** Pin a chat to the top of the list; false when Signal's limit is reached. */
export function setConvPinned(convId: string, val: boolean): boolean {
  const conv = convs[convId];
  if (!conv || !!conv.pinned === val) return true;
  if (val && Object.values(convs).filter((c) => c.pinned).length >= MAX_PINNED_CHATS) return false;
  conv.pinned = val;
  persistConv(conv);
  emit('conversations');
  syncChatState(conv, { pinned: val });
  return true;
}

/** Remember the chat's disappearing-message timer locally; the caller changes it on Signal's side. */
export function setConvExpire(convId: string, secs: number): void {
  const conv = convs[convId];
  if (!conv) return;
  conv.expireTimer = secs || 0;
  persistConv(conv);
  emit('conversations');
}

export function setConversationName(convId: string, name: string): void {
  const conv = convs[convId];
  if (!conv || !name) return;
  conv.name = name;
  persistConv(conv);
  emit('conversations');
}

/** Clear a chat's unread count and send read receipts (up to 10) for what was unread. */
export function markRead(convId: string): void {
  const conv = convs[convId];
  if (!conv) return;
  const hadUnread = conv.unread > 0;
  conv.unread = 0;
  db.getMessagesPage(convId, Number.MAX_SAFE_INTEGER, 25).then((rows) => {
    const pending = rows.filter((r) => r.incoming && r.timestamp > (conv.lastReadTs || 0));
    if (config.sendReadReceipts()) {
      for (const r of pending.slice(-10)) signal.sendReadReceipt(r.author, r.timestamp).catch((e) => dbg('receipt failed ' + (e && e.message)));
    }
    if (pending.length) conv.lastReadTs = pending[pending.length - 1].timestamp;
    persistConv(conv);
  });
  if (hadUnread) emit('conversations');
}

export function markAllRead(): void {
  for (const id of Object.keys(convs)) if (convs[id].unread > 0) markRead(id);
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
    const g = groupsByInternal[internalId];
    conv = newConv(convId, 'group', g ? g.name : 'Group', g ? g.id : null, internalId);
    convs[convId] = conv;
    persistConv(conv);
    emit('conversations');
  }
  return conv;
}

export async function init(): Promise<void> {
  try {
    for (const c of await db.allContacts()) {
      if (c.number) contactsByKey[c.number] = c;
      if (c.uuid) contactsByKey[c.uuid] = c;
    }
    groupsByInternal = (await db.kvGet('groups')) || {};
    for (const c of await db.allConversations()) convs[c.id] = c;
    ready = true;
    emit('conversations');
    purgeExpired();
    if (!purgeTimer) purgeTimer = setInterval(purgeExpired, 30000);
    if (config.isConfigured()) refreshDirectory().catch((e) => dbg('directory refresh failed: ' + (e && e.message)));
  } catch (e: any) {
    ready = true;
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

export function contactsList(): Contact[] {
  const seen: Record<string, true> = {};
  const out: Contact[] = [];
  for (const c of Object.values(contactsByKey)) {
    if (seen[c.id]) continue;
    seen[c.id] = true;
    out.push(c);
  }
  return out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export function groupsList(): GroupRef[] {
  return Object.keys(groupsByInternal)
    .map((k) => ({ internal_id: k, id: groupsByInternal[k].id, name: groupsByInternal[k].name }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export function typing(convId: string): { author: string; until: number } | null {
  const t = typingMap[convId];
  return t && t.until > Date.now() ? t : null;
}

export function setOpenConv(convId: string | null): void {
  openConvId = convId;
}

export function openConversationId(): string | null {
  return openConvId;
}

export function setConnection(s: Connection): void {
  connection = s;
  emit('connection', s);
}

export function connectionState(): Connection {
  return connection;
}

export function isReady(): boolean {
  return ready;
}

export function selfNumber(): string {
  return self();
}
