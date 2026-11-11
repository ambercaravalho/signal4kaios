/* Actions on one message: reactions, pins, deletes, and their syncs. */

import { S } from '../../strings';
import { groupDetail, signal } from '../api';
import { db } from '../db';
import { dbg } from '../log';
import type { StoreEvent, SyncRef } from '../normalize';
import type { Conversation, Message } from '../types';
import { syncChatState } from './chat-state';
import { authorKeys, self } from './contacts';
import { chatFor, emitRemovals, persistConv, removeChat } from './conversations';
import { emit } from './events';
import { enqueueMutation, findMessage, setPreviewIfLast } from './ingest';
import { messageText } from './previews';
import { convs } from './state';

function messageRef(rec: Message): { author: string; timestamp: number } {
  return { author: rec.author, timestamp: rec.timestamp };
}

/** Whether our other devices could have this message: not a notice, and it went out (or came in). */
function addressable(rec: Message): boolean {
  return !rec.notice && rec.status !== 'pending' && rec.status !== 'failed';
}

/** Delete a message from this phone and, as Signal does, from our other devices. */
export function deleteLocal(rec: Message): Promise<void> {
  emit('message-removed', { id: rec.id, convId: rec.convId, timestamp: rec.timestamp });
  const conv = convs[rec.convId];
  if (conv && conv.sendId && addressable(rec)) {
    signal.sendDeleteForMe({ messages: [{ chat: conv.sendId, items: [messageRef(rec)] }] }).catch((e) => dbg('delete sync failed: ' + (e && e.message)));
  }
  return db.deleteMessage(rec.id);
}

/** Signal-Desktop's delete-chat sync names the chat by its newest messages, up to this many. */
const DELETE_CHAT_REFS = 5;

/** Delete a whole chat from this phone and from our other devices. */
export async function deleteChat(convId: string): Promise<void> {
  const conv = convs[convId];
  if (!conv) return;
  if (conv.sendId) {
    const rows = (await db.getMessagesPage(convId, Number.MAX_SAFE_INTEGER, 50)).filter(addressable).reverse();
    const chat = { chat: conv.sendId, mostRecent: rows.slice(0, DELETE_CHAT_REFS).map(messageRef), mostRecentNonExpiring: rows.filter((r) => !r.expiresAt).slice(0, DELETE_CHAT_REFS).map(messageRef) };
    signal.sendDeleteForMe({ chats: [chat] }).catch((e) => dbg('delete chat sync failed: ' + (e && e.message)));
  }
  if (conv.pinned) syncChatState(conv, { pinned: false });
  await removeChat(conv);
}

async function newestListed(convId: string, refs: SyncRef[]): Promise<number> {
  let newest = 0;
  for (const r of refs) {
    const rec = await findMessage(convId, r.timestamp, authorKeys(r.sender));
    if (rec && rec.timestamp > newest) newest = rec.timestamp;
  }
  return newest;
}

async function refreshPreview(conv: Conversation): Promise<void> {
  const last = (await db.getMessagesPage(conv.id, Number.MAX_SAFE_INTEGER, 1))[0];
  const preview = last ? messageText(last) : '';
  if (conv.lastPreview === preview) return;
  conv.lastPreview = preview;
  persistConv(conv);
  emit('conversations');
}

/** Our other device deleted messages or chats; chats lose everything up to the newest message it listed, as in Signal-Desktop. */
export function applyDeleteSync(ev: Extract<StoreEvent, { type: 'deleteSync' }>): void {
  enqueueMutation(async () => {
    const touched: Record<string, Conversation> = {};
    for (const m of ev.messages) {
      const conv = chatFor(m.chat);
      if (!conv) continue;
      for (const item of m.items) {
        const rec = await findMessage(conv.id, item.timestamp, authorKeys(item.sender));
        if (!rec) continue;
        emit('message-removed', { id: rec.id, convId: rec.convId, timestamp: rec.timestamp });
        await db.deleteMessage(rec.id);
        touched[conv.id] = conv;
      }
    }
    for (const c of ev.chats) {
      const conv = chatFor(c.chat);
      if (!conv) continue;
      const upTo = (await newestListed(conv.id, c.mostRecent)) || (await newestListed(conv.id, c.mostRecentNonExpiring));
      if (upTo) {
        emitRemovals(await db.deleteMessagesUpTo(conv.id, upTo));
        touched[conv.id] = conv;
      }
      if (c.isFullDelete && !(await db.getMessagesPage(conv.id, Number.MAX_SAFE_INTEGER, 50)).some((r) => !r.notice)) {
        delete touched[conv.id];
        await removeChat(conv);
      }
    }
    for (const id of Object.keys(touched)) await refreshPreview(touched[id]);
  });
}

/** Signal-Desktop's default `global.adminDeleteMaxAgeInSeconds` (one day); receivers allow another day of grace. */
export const ADMIN_DELETE_MAX_AGE = 24 * 60 * 60 * 1000;
const DELETE_RECEIVE_GRACE = 24 * 60 * 60 * 1000;

function markAdminDeleted(rec: Message): void {
  rec.deleted = true;
  rec.deletedByAdmin = true;
  rec.body = '';
  setPreviewIfLast(rec.convId, rec, S.adminDeleted);
}

/** A group admin deleted someone's message for everyone; ignored unless the group lists them as an admin. */
export function applyAdminDelete(ev: Extract<StoreEvent, { type: 'adminDelete' }>): void {
  const conv = convs[ev.convId];
  if (!conv || conv.type !== 'group' || !conv.sendId) return;
  const sendId = conv.sendId;
  enqueueMutation(async () => {
    const detail = await groupDetail(sendId);
    if ((detail.admins || []).indexOf(ev.admin) < 0) {
      dbg('admin delete from a non-admin ignored');
      return;
    }
    const rec = await findMessage(ev.convId, ev.targetTimestamp, authorKeys(ev.targetAuthor));
    if (!rec || rec.deleted || rec.notice) return;
    if (ev.timestamp - rec.timestamp > ADMIN_DELETE_MAX_AGE + DELETE_RECEIVE_GRACE) {
      dbg('admin delete too old');
      return;
    }
    markAdminDeleted(rec);
    emit('message-updated', rec, undefined);
    await db.putMessage(rec);
  });
}

/** As a group admin, delete someone else's message for everyone. */
export function adminDelete(rec: Message): Promise<void> {
  const conv = convs[rec.convId];
  if (!conv || conv.type !== 'group' || !conv.sendId) return Promise.reject(new Error('group not ready'));
  return signal.sendAdminDelete(conv.sendId, rec.author, rec.timestamp).then(() => {
    markAdminDeleted(rec);
    saveShown(rec);
  });
}

function saveShown(rec: Message): void {
  db.putMessage(rec);
  emit('message-updated', rec, undefined);
}

/** Shows `apply` at once and undoes it with `revert` if `send` fails. */
function optimisticUpdate(rec: Message, apply: () => void, revert: () => void, send: () => Promise<unknown>): Promise<void> {
  apply();
  saveShown(rec);
  return send().then(
    () => undefined,
    (err) => {
      revert();
      saveShown(rec);
      throw err;
    }
  );
}

function sendIdFor(rec: Message): string | null {
  const conv = convs[rec.convId];
  return (conv && conv.sendId) || null;
}

export function reactTo(rec: Message, emoji: string | null): Promise<void> {
  const sendId = sendIdFor(rec);
  if (!sendId) return Promise.reject(new Error('group not ready'));
  const me = self();
  const reactions = (rec.reactions = rec.reactions || {});
  const prev = reactions[me] || null;
  const put = (e: string | null) => (e ? (reactions[me] = e) : delete reactions[me]);
  return optimisticUpdate(rec, () => put(emoji), () => put(prev), () => signal.sendReaction(sendId, rec.incoming ? rec.author : me, rec.timestamp, emoji || prev || '', !emoji));
}

export function deleteForEveryone(rec: Message): Promise<void> {
  const sendId = sendIdFor(rec);
  if (!sendId) return Promise.reject(new Error('group not ready'));
  return signal.sendRemoteDelete(sendId, rec.timestamp).then(() => {
    rec.deleted = true;
    rec.body = '';
    saveShown(rec);
  });
}

/** Pin or unpin a message for everyone in the chat; reverts if sending fails. */
export function setMessagePinned(rec: Message, pinned: boolean): Promise<void> {
  const sendId = sendIdFor(rec);
  if (!sendId) return Promise.reject(new Error('group not ready'));
  return optimisticUpdate(rec, () => (rec.pinned = pinned), () => (rec.pinned = !pinned), () => signal.sendPin(sendId, rec.incoming ? rec.author : self(), rec.timestamp, pinned));
}
