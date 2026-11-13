/* Call lines in 1:1 chats, one per call and replaced as the call's outcome becomes known, and the call log our other devices keep in step with ours. */

import { db } from '../db';
import type { CallEvent, ChatRef } from '../normalize';
import type { CallOutcome, Conversation, Message } from '../types';
import { unarchiveOnActivity } from './chat-state';
import { self } from './contacts';
import { chatFor, ensureConv, persistConv } from './conversations';
import { emit } from './events';
import { enqueueMutation, noticeAlerts, noticeRecord } from './ingest';
import { notify } from './notify';
import { messageText } from './previews';
import { alreadyRead, recountUnread } from './read';
import { convs, state } from './state';

const PAGE = 200;
const UNREAD_PAGE = 50;

/** A later event never takes a call back: an answered call stays answered whichever device says so last. */
const OUTCOME_RANK: Record<CallOutcome, number> = { missed: 0, unanswered: 0, declined: 1, accepted: 2 };

function callMsgId(convId: string, callId: string): string {
  return convId + '|call|' + callId;
}

export function applyCall(ev: CallEvent, silent: boolean): void {
  enqueueMutation(async () => {
    const conv = chatFor(ev.chat) || ensureConv({ convId: ev.chat.key, groupInternalId: null, incoming: true, authorName: '' });
    const id = callMsgId(conv.id, ev.callId);
    const prev = await db.getMessage(id);
    const was = prev && prev.notice;
    if (was && OUTCOME_RANK[was.outcome || 'missed'] > OUTCOME_RANK[ev.outcome]) return;
    const incoming = ev.direction === 'incoming';
    const rec: Message = noticeRecord({
      type: 'notice',
      convId: conv.id,
      groupInternalId: null,
      author: incoming ? conv.id : self(),
      timestamp: prev ? prev.timestamp : ev.timestamp,
      notice: { kind: 'call', callId: ev.callId, direction: ev.direction, outcome: ev.outcome, durationMs: Math.max(ev.durationMs, (was && was.durationMs) || 0) },
    });
    rec.id = id;
    rec.incoming = incoming;
    if (was && was.read) rec.notice!.read = true;
    await db.putMessage(rec);
    const alerts = !prev && noticeAlerts(rec.notice!) && !alreadyRead(conv.id, rec.author, rec.timestamp);
    if (rec.timestamp >= (conv.lastTs || 0)) {
      conv.lastTs = rec.timestamp;
      conv.lastPreview = messageText(rec);
    }
    if (alerts) {
      unarchiveOnActivity(conv);
      if (state.openConvId !== conv.id) conv.unread = (conv.unread || 0) + 1;
    }
    persistConv(conv);
    if (prev) emit('message-updated', rec, undefined);
    else emit('message', rec);
    emit('conversations');
    if (alerts && !silent) notify(conv, rec);
    if (prev && noticeAlerts(prev.notice!) && !noticeAlerts(rec.notice!)) await recountUnread(conv.id);
  });
}

export function applyCallDelete(chat: ChatRef, callId: string): void {
  enqueueMutation(async () => {
    const conv = chatFor(chat);
    const rec = conv && (await db.getMessage(callMsgId(conv.id, callId)));
    if (!conv || !rec) return;
    await removeLines(conv, [rec]);
  });
}

/** Another device marked its call log read, or cleared it, up to `ts`: in one chat, or everywhere. */
export function applyCallLog(action: 'read' | 'clear', chat: ChatRef | null, ts: number): void {
  enqueueMutation(async () => {
    const one = chat && chatFor(chat);
    if (chat && !one) return;
    const targets = one ? [one] : Object.keys(convs).map((id) => convs[id]).filter((c) => c.type === 'direct');
    for (const conv of targets) {
      if (action === 'read') await readLines(conv, ts);
      else await removeLines(conv, await callLines(conv, ts));
    }
  });
}

async function readLines(conv: Conversation, ts: number): Promise<void> {
  if (!conv.unread) return;
  const rows = await db.getMessagesPage(conv.id, Number.MAX_SAFE_INTEGER, UNREAD_PAGE);
  let changed = false;
  for (const r of rows) {
    if (r.timestamp > ts || !r.notice || r.notice.kind !== 'call' || !noticeAlerts(r.notice)) continue;
    r.notice.read = true;
    changed = true;
    await db.putMessage(r);
    emit('message-updated', r, undefined);
  }
  if (changed) await recountUnread(conv.id);
}

/** The chat's call lines up to `ts`, oldest first. */
async function callLines(conv: Conversation, ts: number): Promise<Message[]> {
  const out: Message[] = [];
  let before = ts + 1;
  for (;;) {
    const rows = await db.getMessagesPage(conv.id, before, PAGE);
    if (!rows.length) break;
    for (const r of rows) if (r.notice && r.notice.kind === 'call') out.push(r);
    if (rows.length < PAGE) break;
    before = rows[0].timestamp;
  }
  return out;
}

async function removeLines(conv: Conversation, lines: Message[]): Promise<void> {
  if (!lines.length) return;
  let unread = false;
  for (const r of lines) {
    emit('message-removed', { id: r.id, convId: r.convId, timestamp: r.timestamp });
    await db.deleteMessage(r.id);
    if (r.notice && noticeAlerts(r.notice)) unread = true;
  }
  const newest = (await db.getMessagesPage(conv.id, Number.MAX_SAFE_INTEGER, 1))[0];
  conv.lastPreview = newest ? messageText(newest) : '';
  persistConv(conv);
  emit('conversations');
  if (unread) await recountUnread(conv.id);
}
