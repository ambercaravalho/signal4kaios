/* Read and viewed state, here and from our other devices. */

import { signal } from '../api';
import { config } from '../config';
import { db } from '../db';
import { dbg } from '../log';
import type { SyncRef } from '../normalize';
import type { Attachment, Message } from '../types';
import { syncChatState } from './chat-state';
import { altKeyOf, isSelfKey, self } from './contacts';
import { persistConv } from './conversations';
import { emit } from './events';
import { enqueueMutation, findMessage, noticeAlerts } from './ingest';
import { dismissNotifications } from './notify';
import { convs } from './state';

const UNREAD_PAGE = 50;
const PENDING_READS_MAX = 200;

/** Read syncs for messages that haven't arrived here yet, newest last. */
const pendingReads: Array<{ authors: string[]; timestamp: number }> = [];

function readAuthors(sender: string): string[] {
  const out = [sender, altKeyOf(sender) || ''];
  if (isSelfKey(sender)) out.push(self());
  return out.filter((a, i) => !!a && out.indexOf(a) === i);
}

function countsAsUnread(m: Message): boolean {
  if (!m.incoming) return false;
  return !m.notice || (noticeAlerts(m.notice) && !isSelfKey(m.author));
}

/** Count what's still unread in the chat after a read here or on another device. */
export async function recountUnread(convId: string): Promise<void> {
  const conv = convs[convId];
  if (!conv) return;
  const before = conv.unread || 0;
  if (before > 0) {
    const rows = await db.getMessagesPage(convId, Number.MAX_SAFE_INTEGER, UNREAD_PAGE);
    const left = rows.filter((r) => countsAsUnread(r) && r.timestamp > (conv.lastReadTs || 0)).length;
    if (left < UNREAD_PAGE) conv.unread = Math.min(before, left);
  }
  persistConv(conv);
  if (conv.unread !== before) emit('conversations');
  if (!conv.unread) dismissNotifications(convId);
}

/** Another of our devices read up to `ts` in this chat: what came after it stays unread. */
async function readUpTo(convId: string, ts: number): Promise<void> {
  const conv = convs[convId];
  if (!conv) return;
  conv.lastReadTs = Math.max(conv.lastReadTs || 0, ts);
  return recountUnread(convId);
}

/** Read syncs name the message's author and timestamp, so find which chat it's in, as for viewed syncs. */
export function applyReadSync(entries: Array<{ sender: string; timestamp: number }>): void {
  for (const entry of entries) {
    const authors = readAuthors(entry.sender);
    const candidates = authors.concat(Object.keys(convs).filter((cid) => convs[cid].type === 'group'));
    enqueueMutation(async () => {
      let rec: Message | undefined;
      for (const cid of candidates) {
        if (convs[cid] && (rec = await findMessage(cid, entry.timestamp, authors))) break;
      }
      if (rec) return readUpTo(rec.convId, rec.timestamp);
      pendingReads.push({ authors, timestamp: entry.timestamp });
      if (pendingReads.length > PENDING_READS_MAX) pendingReads.splice(0, pendingReads.length - PENDING_READS_MAX);
    });
  }
}

/** Whether a message arriving now was already read on another device: a read sync came first, or the chat was read past it. */
export function alreadyRead(convId: string, author: string, ts: number): boolean {
  const conv = convs[convId];
  if (conv && conv.lastReadTs && ts <= conv.lastReadTs) return true;
  const i = pendingReads.findIndex((p) => p.timestamp === ts && (p.authors.indexOf(author) >= 0 || p.authors.indexOf(altKeyOf(author) || '') >= 0));
  if (i < 0) return false;
  pendingReads.splice(i, 1);
  if (conv) conv.lastReadTs = Math.max(conv.lastReadTs || 0, ts);
  return true;
}

export function resetPendingReadsForTest(): void {
  pendingReads.length = 0;
}

/** Another of our devices opened these; view-once media also loses its copy here. */
export function applyViewedSync(entries: SyncRef[], viewOnce: boolean): void {
  for (const entry of entries) {
    const authors = [entry.sender, altKeyOf(entry.sender)];
    const candidates = authors.concat(Object.keys(convs).filter((cid) => convs[cid].type === 'group'));
    enqueueMutation(async () => {
      let rec: Message | undefined;
      for (const cid of candidates) {
        if (cid && (rec = await findMessage(cid, entry.timestamp, authors))) break;
      }
      if (!rec || !rec.incoming) return;
      const att = rec.attachments[0];
      if (viewOnce && att && att.viewOnce && att.id) await db.putAttachment(att.id, new Blob([]), '');
      if (rec.viewed) return;
      rec.viewed = true;
      emit('message-updated', rec, undefined);
      await db.putMessage(rec);
    });
  }
}

function tracksViews(att: Attachment | undefined): boolean {
  if (!att) return false;
  const type = att.contentType || '';
  return !!att.viewOnce || !!att.voiceNote || type.indexOf('audio/') === 0 || type.indexOf('video/') === 0;
}

/** The first time we open a received voice message, video, or view-once media: tell the sender (when read receipts are on) and our other devices. */
export function markViewed(m: Message): void {
  const att = m.attachments[0];
  if (!m.incoming || m.viewed || !tracksViews(att)) return;
  m.viewed = true;
  enqueueMutation(async () => {
    const rec = await db.getMessage(m.id);
    if (!rec || rec.viewed) return;
    rec.viewed = true;
    emit('message-updated', rec, undefined);
    await db.putMessage(rec);
  });
  const conv = convs[m.convId];
  signal.sendViewed(m.author, m.timestamp, { receipt: config.sendReadReceipts() && !(conv && conv.request), viewOnce: !!att.viewOnce }).catch((e) => dbg('viewed receipt failed ' + (e && e.message)));
}

/** Clear a chat's unread count and send read receipts (up to 10) for what was unread. */
export function markRead(convId: string): void {
  const conv = convs[convId];
  if (!conv) return;
  const hadUnread = conv.unread > 0 || !!conv.markedUnread;
  conv.unread = 0;
  if (conv.markedUnread) {
    conv.markedUnread = false;
    syncChatState(conv, { markedUnread: false });
  }
  // A message request stays unread for the sender until it's accepted, as in Signal.
  if (conv.request) persistConv(conv);
  else
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
  for (const id of Object.keys(convs)) if (convs[id].unread > 0 || convs[id].markedUnread) markRead(id);
}
