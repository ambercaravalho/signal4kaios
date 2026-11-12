/* Message requests: accepting, deleting, blocking, and reporting spam. */

import { signal } from '../api';
import { db } from '../db';
import type { StoreEvent } from '../normalize';
import type { Conversation } from '../types';
import { chatFor, persistConv, removeChat } from './conversations';
import { emit } from './events';
import { enqueueMutation } from './ingest';
import { markRead } from './read';
import { convs, state } from './state';

function clearRequest(conv: Conversation): void {
  if (!conv.request) return;
  delete conv.request;
  persistConv(conv);
  emit('conversations');
}

/** Who added or invited us to a group, when the engine knows. */
export function groupAddedBy(conv: Conversation): string {
  const g = conv.groupInternalId ? state.groupsByInternal[conv.groupInternalId] : undefined;
  return (g && g.addedBy) || '';
}

function answer(conv: Conversation, response: 'accept' | 'delete' | 'block'): Promise<void> {
  const sendId = conv.sendId!;
  if (conv.type === 'group') return signal.answerGroupRequest(sendId, response);
  const sent = signal.sendMessageRequestResponse(sendId, response);
  return response === 'block' ? sent.then(() => signal.setContactBlocked(sendId, true)) : sent;
}

function requestChat(convId: string): Promise<Conversation> {
  const conv = convs[convId];
  return conv && conv.sendId ? Promise.resolve(conv) : Promise.reject(new Error('unknown chat'));
}

/** Accept a message request: our other devices hear about it, they get our profile, and what we've read gets its read receipts. Accepting a group invite joins the group. */
export function acceptRequest(convId: string): Promise<void> {
  return requestChat(convId).then((conv) =>
    answer(conv, 'accept').then(() => {
      clearRequest(conv);
      markRead(convId);
    })
  );
}

/** Delete a message request, leaving the group if it is one; the response tells our other devices to delete it too. */
export function deleteRequest(convId: string): Promise<void> {
  return requestChat(convId).then((conv) => answer(conv, 'delete').then(() => removeChat(conv)));
}

/** Block the person or group behind a message request; a blocked group is also left. The chat stays, blocked. */
export function blockRequest(convId: string): Promise<void> {
  return requestChat(convId).then((conv) => answer(conv, 'block').then(() => clearRequest(conv)));
}

/** Signal-Desktop reports a chat's 3 most recent incoming messages that carry a server GUID. */
const REPORT_SPAM_MESSAGES = 3;

/** Report a message request as spam to Signal, then block the person and delete the chat here and on our other devices. */
export async function reportSpamRequest(convId: string): Promise<void> {
  const conv = convs[convId];
  if (!conv || !conv.sendId || conv.type !== 'direct') throw new Error('unknown chat');
  const sendId = conv.sendId;
  const recent = await db.getMessagesPage(convId, Number.MAX_SAFE_INTEGER, 100);
  const guids = recent
    .filter((m) => m.incoming && !!m.serverGuid)
    .slice(-REPORT_SPAM_MESSAGES)
    .map((m) => m.serverGuid as string);
  // SECURITY-REVIEW: the reporting token goes only to Signal's report endpoint.
  if (guids.length) await signal.reportSpam(sendId, guids, conv.reportToken);
  await signal.sendMessageRequestResponse(sendId, 'blockAndSpam');
  await signal.setContactBlocked(sendId, true);
  await removeChat(conv);
}

/** Another of our devices answered a message request (or deleted a chat through one). */
export function applyRequestResponse(ev: Extract<StoreEvent, { type: 'requestResponse' }>): void {
  const conv = chatFor(ev.chat);
  if (!conv) return;
  if (ev.response === 'accept' || ev.response === 'block') return clearRequest(conv);
  enqueueMutation(() => removeChat(conv));
}
