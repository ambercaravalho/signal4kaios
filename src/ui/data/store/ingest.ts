/* Applying decrypted events to stored messages and chats. */

import { config } from '../config';
import { db } from '../db';
import { dbg } from '../log';
import { type MessageEvent, type NoticeEvent, parseFrame, type StoreEvent } from '../normalize';
import type { Message, Notice, NoticeKind } from '../types';
import { applyCall, applyCallDelete, applyCallLog } from './call-log';
import { applyBackfill } from './backfill';
import { unarchiveOnActivity } from './chat-state';
import { altKeyOf, canonicalDirectId, displayName, isSelfKey, self } from './contacts';
import { ensureConv, isViewing, mergeConversations, msgId, persistConv, timerLine } from './conversations';
import { emit } from './events';
import { applyAdminDelete, applyDeleteSync } from './message-actions';
import { notify, notifyReaction } from './notify';
import { applyPollEnd, applyPollVote } from './polls';
import { messageText, previewOf } from './previews';
import { alreadyRead, applyReadSync, applyViewedSync, markRead } from './read';
import { applyRequestResponse } from './requests';
import { convs, state, typingMap } from './state';

const STATUS_RANK: Record<string, number> = { pending: 0, failed: 0, sent: 1, delivered: 2, read: 3 };

/** A decrypted frame the database couldn't store. The server can't decrypt it for us again, so the caller holds on to it and retries. */
export class SaveError extends Error {}

/** The writes started while `ingestRaw` applies one frame; null outside it. */
let frameWrites: Array<Promise<unknown>> | null = null;

function track(p: Promise<unknown>): void {
  if (frameWrites) frameWrites.push(p);
}

function isStorageError(e: unknown): boolean {
  return typeof DOMException !== 'undefined' && e instanceof DOMException;
}

/** The stored message for a received or synced one, before reactions, receipts, or edits. */
export function messageRecord(ev: MessageEvent): Message {
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
  if (ev.contactCard) rec.contactCard = ev.contactCard;
  if (ev.poll) rec.poll = { question: ev.poll.question, options: ev.poll.options, allowMultiple: ev.poll.allowMultiple, votes: {} };
  if (ev.preview) rec.preview = ev.preview;
  if (ev.sealed) rec.sealed = true;
  if (ev.serverGuid) rec.serverGuid = ev.serverGuid;
  if (ev.expiresInSeconds) {
    rec.expireSecs = ev.expiresInSeconds;
    // A received message's timer starts when it's read; ours started when it was sent.
    if (!ev.incoming) rec.expiresAt = (ev.timestamp || Date.now()) + ev.expiresInSeconds * 1000;
  }
  return rec;
}

function applyMessage(ev: MessageEvent, silent: boolean): void {
  const conv = ensureConv(ev);
  const rec = messageRecord(ev);
  if (ev.reportToken && conv.type === 'direct') conv.reportToken = ev.reportToken;
  if ((conv.expireTimer || 0) !== ev.expiresInSeconds) conv.expireTimer = ev.expiresInSeconds;
  if (!ev.incoming) delete conv.request;
  const viewing = isViewing(conv.id);
  const read = ev.incoming && !viewing && alreadyRead(conv.id, ev.author, ev.timestamp);
  if (rec.expireSecs && !rec.expiresAt) {
    if (read) rec.expiresAt = Date.now() + rec.expireSecs * 1000;
    else conv.expiryFrom = Math.min(conv.expiryFrom || rec.timestamp, rec.timestamp);
  }
  track(db.putMessage(rec));

  conv.lastTs = Math.max(conv.lastTs || 0, ev.timestamp);
  conv.lastPreview = previewOf(rec);
  unarchiveOnActivity(conv);
  if (ev.incoming && !viewing && !read) conv.unread = (conv.unread || 0) + 1;
  if (typingMap[conv.id]) {
    delete typingMap[conv.id];
    emit('typing', conv.id);
  }
  persistConv(conv);

  emit('message', rec);
  emit('conversations');
  if (ev.incoming && !silent && !read) notify(conv, rec, ev.mentioned);
  if (ev.incoming && viewing) markRead(conv.id);
}

export const ALERTING_NOTICES: NoticeKind[] = ['missedCall', 'payment', 'storyReaction'];

/** Whether a notice counts as unread and notifies: a missed call until it's read in a call log, a payment, or a reaction to your story. */
export function noticeAlerts(n: Notice): boolean {
  if (n.kind === 'call') return n.direction === 'incoming' && n.outcome === 'missed' && !n.read;
  return ALERTING_NOTICES.indexOf(n.kind) >= 0;
}

export function noticeRecord(ev: NoticeEvent): Message {
  return {
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
}

/** Calls, payments, and reactions to your story count as unread and notify, as in Signal, unless they came from one of your own devices; other notices only show in the chat. */
export function applyNotice(ev: NoticeEvent, silent: boolean): void {
  if ((ev.notice.kind === 'safetyNumber' || ev.notice.kind === 'groupUpdate') && !convs[ev.convId]) return;
  const conv = ensureConv({ convId: ev.convId, groupInternalId: ev.groupInternalId, incoming: true, authorName: '' });
  const rec = noticeRecord(ev);
  track(db.putMessage(rec));
  const alerts = noticeAlerts(ev.notice) && !isSelfKey(ev.author);
  if (ev.timestamp >= (conv.lastTs || 0)) {
    conv.lastTs = ev.timestamp;
    conv.lastPreview = messageText(rec);
  }
  if (alerts) {
    unarchiveOnActivity(conv);
    if (!isViewing(conv.id)) conv.unread = (conv.unread || 0) + 1;
  }
  persistConv(conv);
  emit('message', rec);
  emit('conversations');
  if (alerts && !silent) notify(conv, rec);
}

export function enqueueMutation(fn: () => Promise<unknown>): Promise<unknown> {
  const run = state.mutations.then(fn);
  track(run);
  state.mutations = run.catch((e) => dbg('update failed: ' + (e && e.message)));
  return state.mutations;
}

export async function findMessage(convId: string, ts: number, authors: Array<string | null>): Promise<Message | undefined> {
  const ids: string[] = [];
  for (const a of authors) if (a && ids.indexOf(msgId(convId, ts, a)) < 0) ids.push(msgId(convId, ts, a));
  for (const id of ids) {
    const found = await db.getMessage(id);
    if (found) return found;
  }
  return undefined;
}

export function updateTarget(convId: string, ts: number, authors: Array<string | null>, what: string, change: (rec: Message) => void): void {
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

/** Signal-Desktop's MESSAGE_MAX_EDIT_COUNT. */
export const MAX_EDITS = 10;

export function keepVersion(rec: Message): void {
  const version = { body: rec.body, styles: rec.styles || [], timestamp: rec.editedAt || rec.timestamp };
  rec.history = (rec.history || []).concat(version).slice(-MAX_EDITS);
}

export function setPreviewIfLast(convId: string, rec: Message, preview: string): void {
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

export function applyEvent(ev: StoreEvent, silent: boolean): void {
  if ('convId' in ev && typeof ev.convId === 'string' && ev.convId) {
    const was = ev.convId;
    ev.convId = canonicalDirectId(was);
    if ((ev.type === 'message' || ev.type === 'notice') && ev.author === was) ev.author = ev.convId;
    const alt = altKeyOf(ev.convId);
    if (alt && convs[alt] && convs[alt].type === 'direct') {
      const merged = mergeConversations(alt, ev.convId);
      enqueueMutation(() => merged);
    }
  }
  switch (ev.type) {
    case 'message':
      return applyMessage(ev, silent);
    case 'notice':
      return applyNotice(ev, silent);
    case 'reaction':
      return updateTarget(ev.convId, ev.targetTimestamp, [ev.targetAuthor, altKeyOf(ev.targetAuthor), self()], 'reaction', (rec) => {
        rec.reactions = rec.reactions || {};
        const fresh = !ev.remove && rec.reactions[ev.reactor] !== ev.emoji;
        if (ev.remove) delete rec.reactions[ev.reactor];
        else rec.reactions[ev.reactor] = ev.emoji;
        const conv = convs[ev.convId];
        if (fresh && conv && !silent) notifyReaction(conv, ev.reactor, ev.emoji, rec);
      });
    case 'remoteDelete':
      return updateTarget(ev.convId, ev.targetTimestamp, [ev.author, altKeyOf(ev.author)], 'delete', (rec) => {
        rec.deleted = true;
        rec.body = '';
        setPreviewIfLast(ev.convId, rec, 'This message was deleted.');
      });
    case 'edit':
      // Only the author may edit: someone else naming the timestamp of a message you sent must not rewrite it.
      return updateTarget(ev.convId, ev.targetTimestamp, [ev.author, altKeyOf(ev.author)].concat(isSelfKey(ev.author) ? [self()] : []), 'edit', (rec) => {
        if (ev.timestamp && rec.editedAt === ev.timestamp) return;
        keepVersion(rec);
        rec.body = ev.newBody;
        rec.styles = ev.newStyles || [];
        rec.edited = true;
        if (ev.timestamp) rec.editedAt = ev.timestamp;
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
    case 'viewedSync':
      return applyViewedSync(ev.entries, ev.viewOnce);
    case 'deleteSync':
      return applyDeleteSync(ev);
    case 'adminDelete':
      return applyAdminDelete(ev);
    case 'requestResponse':
      return applyRequestResponse(ev);
    case 'backfill':
      return applyBackfill(ev);
    case 'pollVote':
      return applyPollVote(ev);
    case 'pollEnd':
      return applyPollEnd(ev);
    case 'call':
      return applyCall(ev, silent);
    case 'callDelete':
      return applyCallDelete(ev.chat, ev.callId);
    case 'callLog':
      return applyCallLog(ev.action, ev.chat, ev.timestamp);
    case 'timer': {
      const conv = convs[ev.convId];
      if (!conv || (conv.expireTimer || 0) === ev.seconds) return;
      conv.expireTimer = ev.seconds;
      persistConv(conv);
      emit('conversations');
      if (conv.type === 'direct') timerLine(conv, ev.author, ev.seconds, ev.timestamp);
      return;
    }
  }
}

/** Apply one decrypted frame; resolves once its writes are stored, and rejects with `SaveError` when the database refused one. `silent` while the first connection after launch drains the offline queue, which doesn't notify. */
export function ingestRaw(frame: unknown, opts?: { silent?: boolean }): Promise<void> {
  const writes: Array<Promise<unknown>> = [];
  let thrown: unknown = null;
  frameWrites = writes;
  try {
    for (const ev of parseFrame(frame, self(), displayName)) applyEvent(ev, !!(opts && opts.silent));
  } catch (e) {
    thrown = e || new Error('apply failed');
  } finally {
    frameWrites = null;
  }
  return Promise.allSettled(writes).then((results) => {
    if (thrown) throw thrown;
    for (const r of results) {
      if (r.status !== 'rejected') continue;
      const e = r.reason;
      throw isStorageError(e) ? new SaveError(String((e && e.message) || e)) : e;
    }
  });
}
