/* Sync messages from our other devices: read, viewed, delete-for-me, and message request responses. */

import type { ChatDelete, ChatRef, RequestResponse, StoreEvent, SyncRef } from './events';
import { num, str } from './fields';

export const REQUEST_RESPONSES: RequestResponse[] = ['accept', 'delete', 'block', 'blockAndDelete', 'spam', 'blockAndSpam'];

const MAX_SYNC_DELETES = 500;

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
