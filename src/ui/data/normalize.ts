/* Turns the JSON frames the engine produces from decrypted envelopes into typed events for the store. Frames are untrusted: unknown or malformed shapes are logged and dropped, never thrown. */

import { dbg } from './log';
import { callRecordEvents, callSyncEvents } from './normalize/calls';
import type { Conv, NameOf, RequestResponse, StoreEvent } from './normalize/events';
import { num, str } from './normalize/fields';
import { groupUpdateEvents } from './normalize/group';
import { dataMessageEvents, editEvent, noticeEvent, peerKey } from './normalize/message';
import { backfillEvent, chatRef, deleteSyncEvent, REQUEST_RESPONSES, syncRefs } from './normalize/sync';

export { type BackfillSlot, type CallEvent, type ChatDelete, type ChatRef, type MessageEvent, type NoticeEvent, type RequestResponse, type StoreEvent, type SyncRef } from './normalize/events';
export { applyMentions } from './normalize/message';

/** Events for one decrypted frame. `selfNumber` is the author of messages synced from our other devices; `nameOf` names mentioned people. */
export function parseFrame(frame: unknown, selfNumber: string, nameOf: NameOf): StoreEvent[] {
  const raw = frame && typeof frame === 'object' ? (frame as { envelope?: unknown }).envelope : undefined;
  if (!raw || typeof raw !== 'object') {
    dbg('normalize: frame without envelope');
    return [];
  }

  const env = raw as Record<string, unknown>;
  const events = envelopeEvents(env, selfNumber, nameOf);
  const peer = peerKey(env);
  // One millisecond early, so it sits before the message it arrived with and can't share that message's ID.
  if (env.safetyNumberChanged && peer) events.unshift(...noticeEvent(env, { kind: 'safetyNumber', timestamp: (num(env.timestamp) || Date.now()) - 1 }, { convId: peer, groupInternalId: null }, peer));
  return events;
}

function envelopeEvents(env: any, selfNumber: string, nameOf: NameOf): StoreEvent[] {
  if (env.groupUpdate) return groupUpdateEvents(env.groupUpdate);
  if (env.notice) return noticeEvent(env, env.notice, { convId: peerKey(env), groupInternalId: null }, peerKey(env) || '');
  if (env.callRecord) return callRecordEvents(env);
  if (env.dataMessage) return dataMessageEvents(env, env.dataMessage, true, nameOf);
  if (env.editMessage) return editEvent(env, env.editMessage, peerKey(env) || '', nameOf);

  if (env.typingMessage) {
    const tm = env.typingMessage;
    const convId = tm.groupId ? 'g:' + tm.groupId : peerKey(env);
    if (!convId) return [];
    return [{ type: 'typing', convId, author: peerKey(env) || '', started: tm.action === 'STARTED' }];
  }

  if (env.receiptMessage) {
    const rm = env.receiptMessage;
    const peer = peerKey(env);
    if (!peer) return [];
    const timestamps: number[] = Array.isArray(rm.timestamps) ? rm.timestamps.map(num) : rm.when ? [num(rm.when)] : [];
    return [{ type: 'receipt', peer, kind: rm.isRead || rm.isViewed ? 'read' : rm.isDelivery ? 'delivery' : 'other', timestamps }];
  }

  if (env.syncMessage) {
    const sm = env.syncMessage;
    if (sm.sentMessage) {
      const sent = sm.sentMessage;
      const dest = str(sent.destinationNumber) || str(sent.destinationUuid) || str(sent.destination);
      const conv: Conv = sent.groupInfo && sent.groupInfo.groupId ? { convId: 'g:' + sent.groupInfo.groupId, groupInternalId: str(sent.groupInfo.groupId) } : { convId: dest || null, groupInternalId: null };
      if (sent.editMessage) return editEvent(env, sent.editMessage, selfNumber, nameOf, conv);
      return dataMessageEvents(env, sent, false, nameOf, selfNumber, conv);
    }
    const out: StoreEvent[] = [];
    const read = syncRefs(sm.readMessages);
    if (read.length) out.push({ type: 'readSync', entries: read });
    const viewed = syncRefs(sm.viewedMessages);
    if (viewed.length) out.push({ type: 'viewedSync', entries: viewed, viewOnce: false });
    const opened = syncRefs(sm.viewOnceOpen ? [sm.viewOnceOpen] : undefined);
    if (opened.length) out.push({ type: 'viewedSync', entries: opened, viewOnce: true });
    const mrr = sm.messageRequestResponse;
    if (mrr && typeof mrr === 'object') {
      const chat = chatRef({ groupId: mrr.groupId, uuid: mrr.threadUuid });
      const response = str(mrr.type) as RequestResponse;
      if (chat && REQUEST_RESPONSES.indexOf(response) >= 0) out.push({ type: 'requestResponse', chat, response });
    }
    if (sm.deleteForMe && typeof sm.deleteForMe === 'object') {
      const del = deleteSyncEvent(sm.deleteForMe);
      if (del) out.push(del);
    }
    if (sm.attachmentBackfill && typeof sm.attachmentBackfill === 'object') {
      const backfill = backfillEvent(sm.attachmentBackfill);
      if (backfill) out.push(backfill);
    }
    out.push(...callSyncEvents(sm));
    if (!out.length) dbg('normalize: unhandled sync message ' + Object.keys(sm).join(','));
    return out;
  }

  dbg('normalize: unhandled envelope ' + Object.keys(env).join(','));
  return [];
}
