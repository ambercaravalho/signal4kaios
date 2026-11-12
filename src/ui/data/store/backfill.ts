/* Asking our primary phone for attachments Signal's servers no longer have, like Signal-Desktop's attachmentBackfill: one request per message, answered by a `backfill` event or given up on after a wait. */

import { signal } from '../api';
import { loadAttachment } from '../attachments';
import type { BackfillSlot, StoreEvent } from '../normalize';
import type { Attachment, Message } from '../types';
import { altKeyOf, self } from './contacts';
import { chatFor } from './conversations';
import { updateTarget } from './ingest';
import { convs } from './state';

export const BACKFILL_WAIT_MS = 10000;
/** How long to keep waiting once the phone says it's still uploading. */
const PENDING_WAIT_MS = 60000;

export class NoLongerAvailableError extends Error {}

interface Waiter {
  index: number;
  resolve(att: Attachment): void;
  reject(e: Error): void;
}

const asks: Record<string, { timer: ReturnType<typeof setTimeout>; waiters: Waiter[] }> = {};

function giveUp(id: string): void {
  const ask = asks[id];
  if (!ask) return;
  clearTimeout(ask.timer);
  delete asks[id];
  for (const w of ask.waiters) w.reject(new NoLongerAvailableError('not available'));
}

/** A fresh copy of `msg.attachments[index]` from our phone; rejects with `NoLongerAvailableError` when it can't send one. */
export function askPhoneForAttachment(msg: Message, index: number): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const open = asks[msg.id];
    if (open) {
      open.waiters.push({ index, resolve, reject });
      return;
    }
    const conv = convs[msg.convId];
    if (!conv || !conv.sendId) return reject(new NoLongerAvailableError('no chat'));
    asks[msg.id] = { timer: setTimeout(() => giveUp(msg.id), BACKFILL_WAIT_MS), waiters: [{ index, resolve, reject }] };
    signal.requestAttachmentBackfill(conv.sendId, { author: msg.author, timestamp: msg.timestamp }).then(
      (sent) => {
        if (!sent) giveUp(msg.id);
      },
      () => giveUp(msg.id)
    );
  });
}

function isGone(e: unknown): boolean {
  const status = e && (e as { status?: number }).status;
  return status === 404 || status === 403;
}

/** `loadAttachment`, asking our phone for a fresh copy when Signal's servers no longer have it; `onAsking` runs once the request goes out. */
export function loadOrAskPhone(att: Attachment, msg: Message | undefined, onAsking: () => void): Promise<Blob> {
  return loadAttachment(att).catch((e) => {
    const index = msg && !att.viewOnce ? msg.attachments.findIndex((a) => a.id === att.id) : -1;
    if (!msg || index < 0 || !isGone(e)) throw e;
    onAsking();
    return askPhoneForAttachment(msg, index).then(loadAttachment);
  });
}

function answer(rec: Message, slots: BackfillSlot[] | null): void {
  const ask = asks[rec.id];
  if (!ask) return;
  clearTimeout(ask.timer);
  const left = ask.waiters.filter((w) => {
    const slot = slots ? slots[w.index] : 'failed';
    if (slot === 'pending') return true;
    if (slot && typeof slot === 'object') w.resolve(rec.attachments[w.index]);
    else w.reject(new NoLongerAvailableError('not available'));
    return false;
  });
  if (!left.length) {
    delete asks[rec.id];
    return;
  }
  ask.waiters = left;
  ask.timer = setTimeout(() => giveUp(rec.id), PENDING_WAIT_MS);
}

/** Our phone's answer, to our request or another device's: fresh copies replace the old attachments in place. */
export function applyBackfill(ev: Extract<StoreEvent, { type: 'backfill' }>): void {
  const conv = chatFor(ev.chat);
  if (!conv) return;
  updateTarget(conv.id, ev.timestamp, [ev.author, altKeyOf(ev.author), self()], 'backfill', (rec) => {
    const slots = ev.slots;
    if (slots) {
      rec.attachments = rec.attachments.map((old, i) => {
        const slot = slots[i];
        return slot && typeof slot === 'object' ? { ...old, ...slot, viewOnce: old.viewOnce } : old;
      });
    }
    answer(rec, slots);
  });
}
