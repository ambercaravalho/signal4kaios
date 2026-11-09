/* Plain-language errors. The technical detail goes to the debug log, never to the screen. */

import { dbg } from './data/log';
import { S } from './strings';

/** A sentence the user can act on, for any error thrown by the engine, network, or store. */
export function friendlyError(err: unknown, fallback: string = S.errGeneric): string {
  const e = (err || {}) as { kind?: string; status?: number; message?: string; name?: string };
  const msg = String(e.message || '');
  dbg('error: ' + (e.kind ? e.kind + ' ' : '') + (e.status ? e.status + ' ' : '') + msg);
  if (e.kind === 'network' || /network|offline|connect|socket/i.test(msg)) return S.errOffline;
  if (e.kind === 'timeout' || /timed? ?out/i.test(msg)) return S.errTimeout;
  if (e.status === 401 || e.status === 403) return e.status === 401 ? S.errUnlinked : S.errNotAllowed;
  if (e.status === 413 || e.status === 429) return S.errRateLimited;
  if (e.status === 404) return S.errNotFound;
  if (/group not ready/.test(msg)) return S.groupNotReady;
  return fallback;
}

/** `friendlyError` for an action that sent something. */
export function sendError(err: unknown): string {
  return friendlyError(err, S.errSend);
}
