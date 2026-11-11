/* Applying decrypted events to stored messages and chats. */

import { config } from '../config';
import { db } from '../db';
import { dbg } from '../log';
import { type MessageEvent, type NoticeEvent, parseFrame, type StoreEvent } from '../normalize';
import type { Message } from '../types';
import { unarchiveOnActivity } from './chat-state';
import { altKeyOf, displayName, self } from './contacts';
import { ensureConv, msgId, persistConv, timerLine } from './conversations';
import { emit } from './events';
import { applyAdminDelete, applyDeleteSync } from './message-actions';
import { notify } from './notify';
import { applyPollEnd, applyPollVote } from './polls';
import { messageText, previewOf } from './previews';
import { applyReadSync, applyViewedSync, markRead } from './read';
import { applyRequestResponse } from './requests';
import { convs, state, typingMap } from './state';

const STATUS_RANK: Record<string, number> = { pending: 0, failed: 0, sent: 1, delivered: 2, read: 3 };

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
  if (ev.contactCard) rec.contactCard = ev.contactCard;
  if (ev.poll) rec.poll = { question: ev.poll.question, options: ev.poll.options, allowMultiple: ev.poll.allowMultiple, votes: {} };
  if (ev.preview) rec.preview = ev.preview;
  if (ev.sealed) rec.sealed = true;
  if (ev.serverGuid) rec.serverGuid = ev.serverGuid;
  if (ev.reportToken && conv.type === 'direct') conv.reportToken = ev.reportToken;
  if (ev.expiresInSeconds) {
    rec.expireSecs = ev.expiresInSeconds;
    rec.expiresAt = Date.now() + ev.expiresInSeconds * 1000;
  }
  if ((conv.expireTimer || 0) !== ev.expiresInSeconds) conv.expireTimer = ev.expiresInSeconds;
  if (!ev.incoming) delete conv.request;
  db.putMessage(rec);

  conv.lastTs = Math.max(conv.lastTs || 0, ev.timestamp);
  conv.lastPreview = previewOf(rec);
  unarchiveOnActivity(conv);
  if (ev.incoming && state.openConvId !== conv.id) conv.unread = (conv.unread || 0) + 1;
  if (typingMap[conv.id]) {
    delete typingMap[conv.id];
    emit('typing', conv.id);
  }
  persistConv(conv);

  emit('message', rec);
  emit('conversations');
  // Draining the offline queue (silent) must not notify per message: the queue replays on every reconnect.
  if (ev.incoming && !silent) notify(conv, rec, ev.mentioned);
  if (ev.incoming && state.openConvId === conv.id) markRead(conv.id);
}

/** Missed calls count as unread and notify, as in Signal; other notices only show in the chat. */
export function applyNotice(ev: NoticeEvent, silent: boolean): void {
  if ((ev.notice.kind === 'safetyNumber' || ev.notice.kind === 'groupUpdate') && !convs[ev.convId]) return;
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
    if (state.openConvId !== conv.id) conv.unread = (conv.unread || 0) + 1;
  }
  persistConv(conv);
  emit('message', rec);
  emit('conversations');
  if (alerts && !silent) notify(conv, rec);
}

export function enqueueMutation(fn: () => Promise<unknown>): Promise<unknown> {
  state.mutations = state.mutations.then(fn).catch((e) => dbg('update failed: ' + (e && e.message)));
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
    case 'pollVote':
      return applyPollVote(ev);
    case 'pollEnd':
      return applyPollEnd(ev);
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

/** Apply one decrypted frame. `silent` while draining the offline queue, so queued messages don't each notify. */
export function ingestRaw(frame: unknown, opts?: { silent?: boolean }): void {
  for (const ev of parseFrame(frame, self(), displayName)) applyEvent(ev, !!(opts && opts.silent));
}
