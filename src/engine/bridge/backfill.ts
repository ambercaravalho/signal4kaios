/* Asking our primary phone to upload a message's attachments again once the CDN dropped them, like Signal-Desktop's attachmentBackfill. */

import { ContentSchema } from '../gen/SignalService_pb';
import { create } from '../net/proto';
import { fetchAndDecryptProfile } from '../services/profiles';
import { client, httpJson, serverUrl, store } from './context';
import { addressableMessages, conversationIdentifier, type MessageRef } from './delivery';

const RECHECK_MS = 60 * 60 * 1000;
let capable: { value: boolean; at: number } | null = null;

async function phoneCanBackfill(): Promise<boolean> {
  if (capable && (capable.value || Date.now() - capable.at < RECHECK_MS)) return capable.value;
  const acc = await store.getAccount();
  if (!acc) return false;
  const prof = await fetchAndDecryptProfile(store, httpJson, acc.aci, acc.profileKey, serverUrl());
  capable = { value: !!(prof && prof.capabilities.attachmentBackfill), at: Date.now() };
  return capable.value;
}

export const backfillMethods = {
  /** Ask our primary phone to upload a message's attachments again. False when it can't, or the chat or author is unknown; the answer arrives later as an `attachmentBackfill` sync frame. */
  async requestAttachmentBackfill(sendId: string, ref: MessageRef): Promise<boolean> {
    if (!(await phoneCanBackfill())) return false;
    const targetConversation = await conversationIdentifier(sendId);
    const [targetMessage] = await addressableMessages([ref]);
    if (!targetConversation || !targetMessage) return false;
    const request = { targetMessage, targetConversation };
    await client.sendSyncMessage(create(ContentSchema, { content: { case: 'syncMessage', value: { content: { case: 'attachmentBackfillRequest', value: request } } } }));
    return true;
  },
};
