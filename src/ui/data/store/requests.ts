/* Message requests: accepting, deleting, blocking, and reporting spam. */

import { signal } from '../api';
import { db } from '../db';
import type { StoreEvent } from '../normalize';
import type { Conversation } from '../types';
import { chatFor, persistConv, removeChat } from './conversations';
import { emit } from './events';
import { enqueueMutation } from './ingest';
import { markRead } from './read';
import { convs } from './state';

function clearRequest(conv: Conversation): void {
  if (!conv.request) return;
  delete conv.request;
  persistConv(conv);
  emit('conversations');
}

/** Accept a message request: our other devices hear about it, they get our profile, and what we've read gets its read receipts. */
export function acceptRequest(convId: string): Promise<void> {
  const conv = convs[convId];
  if (!conv || !conv.sendId) return Promise.reject(new Error('unknown chat'));
  return signal.sendMessageRequestResponse(conv.sendId, 'accept').then(() => {
    clearRequest(conv);
    markRead(convId);
  });
}

/** Delete a message request; the response tells our other devices to delete it too. */
export function deleteRequest(convId: string): Promise<void> {
  const conv = convs[convId];
  if (!conv || !conv.sendId) return Promise.reject(new Error('unknown chat'));
  return signal.sendMessageRequestResponse(conv.sendId, 'delete').then(() => removeChat(conv));
}

/** Block the person behind a message request. The chat stays, blocked. */
export function blockRequest(convId: string): Promise<void> {
  const conv = convs[convId];
  if (!conv || !conv.sendId) return Promise.reject(new Error('unknown chat'));
  const sendId = conv.sendId;
  return signal
    .sendMessageRequestResponse(sendId, 'block')
    .then(() => signal.setContactBlocked(sendId, true))
    .then(() => clearRequest(conv));
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
