/* Waiting for the phone to upload the link-and-sync archive (Signal-Desktop `getTransferArchive`): each request waits up to five minutes on the server, for an hour in all. */

import { asObject, type BasicAuth, type SignalHttpJsonFn } from '../../net/http';

export type TransferArchive = { cdn: number; key: string } | { error: 'RELINK_REQUESTED' | 'CONTINUE_WITHOUT_UPLOAD' };

const TOTAL_WAIT_MS = 60 * 60 * 1000;
const REQUEST_WAIT_MS = 5 * 60 * 1000;
const LEEWAY_MS = 15 * 1000;
const CDN_KEY = /^[A-Za-z0-9_\-.=]{1,256}$/;

/** The archive's location, or the phone's decision not to send one. Throws on an answer that is neither. */
export function parseTransferArchive(res: unknown): TransferArchive | null {
  const o = asObject(res);
  if (!o) return null;
  if (typeof o.cdn === 'number' && Number.isInteger(o.cdn) && typeof o.key === 'string' && CDN_KEY.test(o.key)) return { cdn: o.cdn, key: o.key };
  if (o.error === 'RELINK_REQUESTED' || o.error === 'CONTINUE_WITHOUT_UPLOAD') return { error: o.error };
  throw new Error('Unexpected transfer archive response');
}

/** Null when the hour passed, or `cancelled` turned true, before the phone answered. */
export async function waitForTransferArchive(http: SignalHttpJsonFn, baseUrl: string, basicAuth: BasicAuth, cancelled: () => boolean, now: () => number = Date.now): Promise<TransferArchive | null> {
  const until = now() + TOTAL_WAIT_MS;
  while (!cancelled()) {
    const remaining = until - now();
    if (remaining <= 0) return null;
    const secs = Math.max(1, Math.round(Math.min(remaining, REQUEST_WAIT_MS) / 1000));
    // SECURITY-REVIEW: polled with this device's own credentials, sent only to Signal's chat server.
    const res = await http('GET', `/v1/devices/transfer_archive?timeout=${secs}`, null, { baseUrl, basicAuth, timeout: secs * 1000 + LEEWAY_MS });
    const archive = parseTransferArchive(res);
    if (archive) return archive;
  }
  return null;
}
