/* Sync messages from our other devices: read, viewed, delete-for-me, message request responses, and attachment backfill answers. */

import type { BackfillSlot, ChatDelete, ChatRef, RequestResponse, StoreEvent, SyncRef } from './events';
import { num, str } from './fields';
import { attachmentOf } from './message';

export const REQUEST_RESPONSES: RequestResponse[] = ['accept', 'delete', 'block', 'blockAndDelete', 'spam', 'blockAndSpam'];

const MAX_SYNC_DELETES = 500;
const MAX_BACKFILL_SLOTS = 100;

export function syncRefs(list: unknown): SyncRef[] {
  if (!Array.isArray(list)) return [];
  const out: SyncRef[] = [];
  for (const r of list) {
    if (!r) continue;
    const sender = str(r.senderNumber) || str(r.senderUuid) || str(r.sender);
    if (sender && r.timestamp) out.push({ sender, timestamp: num(r.timestamp) });
  }
  return out;
}

export function chatRef(c: any): ChatRef | null {
  if (!c || typeof c !== 'object') return null;
  const key = c.groupId ? 'g:' + str(c.groupId) : str(c.number) || str(c.uuid);
  return key && key !== 'g:' ? { key } : null;
}

function addressed(list: unknown): SyncRef[] {
  return syncRefs(Array.isArray(list) ? list.slice(0, MAX_SYNC_DELETES).map((m: any) => m && { sender: m.author, timestamp: m.timestamp }) : []);
}

export function deleteSyncEvent(d: any): StoreEvent | null {
  const messages: Array<{ chat: ChatRef; items: SyncRef[] }> = [];
  for (const md of Array.isArray(d.messages) ? d.messages : []) {
    const chat = md && chatRef(md.conversation);
    const items = md ? addressed(md.messages) : [];
    if (chat && items.length) messages.push({ chat, items });
  }
  const chats: ChatDelete[] = [];
  for (const cd of Array.isArray(d.conversations) ? d.conversations : []) {
    const chat = cd && chatRef(cd.conversation);
    if (chat) chats.push({ chat, mostRecent: addressed(cd.mostRecent), mostRecentNonExpiring: addressed(cd.mostRecentNonExpiring), isFullDelete: !!cd.isFullDelete });
  }
  return messages.length || chats.length ? { type: 'deleteSync', messages, chats } : null;
}

/** Our phone's answer to a backfill request; `slots` is null when it no longer has the message. */
export function backfillEvent(b: any): StoreEvent | null {
  const chat = chatRef(b.conversation);
  const [target] = addressed(b.message ? [b.message] : []);
  if (!chat || !target) return null;
  const slots: BackfillSlot[] | null = Array.isArray(b.attachments)
    ? b.attachments.slice(0, MAX_BACKFILL_SLOTS).map((a: any) => (a === 'pending' ? 'pending' : a && typeof a === 'object' && str(a.id) ? attachmentOf(a, false) : 'failed'))
    : null;
  return { type: 'backfill', chat, author: target.sender, timestamp: target.timestamp, slots };
}
