/* Web Push: store subscriptions, and on a new incoming message send an
   aesgcm-encrypted payload so the app's ServiceWorker cold-wakes and shows the
   note directly. Push is skipped when the app is currently connected for that
   number (it notifies itself) unless PUSH_WHEN_IDLE_ONLY is false. */

import webpush from 'web-push';
import { config } from './config';
import { log, maskNumber } from './log';
import * as buffer from './buffer';
import * as clients from './clients';
import * as upstream from './upstream';
import { toNote } from './parse';

// Whether VAPID is configured. KaiOS only delivers a *payload* push when it is
// VAPID-signed; without VAPID it allows empty "tickles" only.
let vapidReady = false;

export function init(): void {
  if (config.vapidPublic && config.vapidPrivate) {
    try {
      webpush.setVapidDetails(config.vapidSubject, config.vapidPublic, config.vapidPrivate);
      vapidReady = true;
      log.info('push: VAPID configured');
    } catch (e) {
      log.error('push: invalid VAPID keys', e);
    }
  } else {
    log.info('push: no VAPID keys (empty tickles only — set VAPID for payloads)');
  }
}

export function vapidPublicKey(): string {
  return config.vapidPublic || '';
}

/* Register (or refresh) a subscription for a number and make sure we are
   buffering that number so closed-app pushes can be produced. */
export function register(number: string, subscription: unknown): void {
  if (!number || !subscription) return;
  buffer.addSub(number, subscription);
  buffer.addNumber(number);
  upstream.ensureNumber(number);
  log.info('push: registered subscription for ' + maskNumber(number));
}

export function unregister(endpoint: string): void {
  if (!endpoint) return;
  buffer.removeSubByEndpoint(endpoint);
  log.info('push: unregistered a subscription');
}

// KaiOS's push service (notification.kaiostech.com) is a fork of Mozilla's old
// autopush and has two hard rules:
//   1. It only accepts the legacy 'aesgcm' content encoding (not web-push's
//      default 'aes128gcm'), so we force it below.
//   2. An empty "tickle" does NOT reliably cold-wake a stopped ServiceWorker; a
//      real VAPID-signed encrypted payload does. So when VAPID is configured we
//      send the note as an aesgcm payload and the SW shows it directly. Without
//      VAPID the push service only allows empty pushes (a generic notice).
const PUSH_TTL = 3600;

function sendOptions(): webpush.RequestOptions {
  return { TTL: PUSH_TTL, contentEncoding: 'aesgcm' };
}

/* Mask a push endpoint for logs/responses: host + the last 12 chars of the token
   (enough to compare against the device's current subscription, not enough to be
   a usable capability URL). */
function maskEndpoint(endpoint?: string): string {
  if (!endpoint) return '(none)';
  try {
    const u = new URL(endpoint);
    const tail = endpoint.slice(-12);
    return u.host + '/…' + tail;
  } catch {
    return '…' + endpoint.slice(-12);
  }
}

/* Send to one subscription; prune it if the service says it's gone. Resolves to
   a small status object (used by the manual test endpoint). */
function sendTo(
  number: string,
  sub: unknown,
  payload: string | undefined
): Promise<{ statusCode?: number; error?: string; endpoint?: string }> {
  const ep = (sub as { endpoint?: string }).endpoint;
  return webpush
    .sendNotification(sub as webpush.PushSubscription, payload, sendOptions())
    .then(function (res) {
      log.info('push: sent to ' + maskNumber(number) + ' ' + maskEndpoint(ep) +
        ' (' + res.statusCode + ')');
      return { statusCode: res.statusCode, endpoint: maskEndpoint(ep) };
    })
    .catch(function (err: any) {
      const status = err && err.statusCode;
      if (status === 404 || status === 410) {
        if (ep) buffer.removeSubByEndpoint(ep);
        log.warn('push: pruned expired subscription for ' + maskNumber(number));
      } else {
        const detail = (err && err.body) || (err && err.message) || String(err);
        log.error('push: send failed for ' + maskNumber(number) +
          (status ? ' (' + status + ')' : '') + ': ' + detail);
      }
      return { statusCode: status, error: (err && err.body) || (err && err.message), endpoint: maskEndpoint(ep) };
    });
}

/* Called by the upstream receiver for every incoming frame. */
export function onIncoming(number: string, text: string): void {
  const note = toNote(text);
  if (!note || !note.incoming) return;

  // The app is open for this number; it will show its own notification.
  if (config.pushWhenIdleOnly && clients.count(number) > 0) {
    log.info('push: skipped, app connected for ' + maskNumber(number));
    return;
  }

  const subs = buffer.subsFor(number);
  if (!subs.length) {
    log.info('push: no subscriptions for ' + maskNumber(number));
    return;
  }

  // Send the note as an aesgcm payload (this is what cold-wakes the SW on
  // KaiOS); without VAPID we can only send an empty push (generic notice).
  const payload = vapidReady ? JSON.stringify(note) : undefined;
  subs.forEach(function (sub) { sendTo(number, sub, payload); });
}

/* Manual test: push a canned note to every subscription for a number, ignoring
   the idle gate. Returns per-subscription results so a caller can see exactly
   what the push service reported. Pass empty=true to send a PAYLOADLESS push
   (a "tickle"): nothing to decrypt, so if it's delivered at all the SW's 'push'
   event must fire — a pure delivery/wake probe that isolates delivery failures
   from payload-decryption failures. */
export function sendTest(
  number: string,
  empty?: boolean
): Promise<Array<{ statusCode?: number; error?: string; endpoint?: string }>> {
  const subs = buffer.subsFor(number);
  const note = { title: 'Signal', body: 'Test notification', convId: '', incoming: true };
  const payload = (!empty && vapidReady) ? JSON.stringify(note) : undefined;
  return Promise.all(subs.map(function (sub) { return sendTo(number, sub, payload); }));
}
