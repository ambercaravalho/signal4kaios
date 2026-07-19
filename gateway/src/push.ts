/* Web Push: store subscriptions, and on a new incoming message deliver a push
   (payload + a pending-queue fallback for payloadless "tickle" services). Push
   is skipped when the app is currently connected for that number (it notifies
   itself) unless PUSH_WHEN_IDLE_ONLY is false. */

import webpush from 'web-push';
import { config } from './config';
import { log, maskNumber } from './log';
import * as buffer from './buffer';
import * as clients from './clients';
import * as upstream from './upstream';
import { toNote } from './parse';

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
    log.info('push: no VAPID keys (sending without VAPID)');
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

export function pending(number: string): unknown[] {
  return buffer.takePending(number);
}

// KaiOS's push service (notification.kaiostech.com) is a fork of Mozilla's old
// autopush: it ONLY accepts the legacy 'aesgcm' content encoding (not web-push's
// default 'aes128gcm'), and it only allows an encrypted PAYLOAD when the push is
// VAPID-signed. Without VAPID we must send a payloadless "tickle" and let the
// ServiceWorker pull the note from /v1/push/pending.
const PUSH_TTL = 3600;

function sendOptions(): webpush.RequestOptions {
  return { TTL: PUSH_TTL, contentEncoding: 'aesgcm' };
}

/* Send to one subscription; prune it if the service says it's gone. Resolves to
   a small status object (used by the manual test endpoint). */
function sendTo(
  number: string,
  sub: unknown,
  payload: string | undefined
): Promise<{ statusCode?: number; error?: string }> {
  return webpush
    .sendNotification(sub as webpush.PushSubscription, payload, sendOptions())
    .then(function (res) {
      log.info('push: sent to ' + maskNumber(number) + ' (' + res.statusCode + ')');
      return { statusCode: res.statusCode };
    })
    .catch(function (err: any) {
      const status = err && err.statusCode;
      if (status === 404 || status === 410) {
        const endpoint = (sub as { endpoint?: string }).endpoint;
        if (endpoint) buffer.removeSubByEndpoint(endpoint);
        log.warn('push: pruned expired subscription for ' + maskNumber(number));
      } else {
        const detail = (err && err.body) || (err && err.message) || String(err);
        log.error('push: send failed for ' + maskNumber(number) +
          (status ? ' (' + status + ')' : '') + ': ' + detail);
      }
      return { statusCode: status, error: (err && err.body) || (err && err.message) };
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

  // Always queue for the tickle fallback, then push. With VAPID we can carry an
  // encrypted payload; without it we send an empty tickle (KaiOS requirement).
  buffer.addPending(number, note);
  const payload = vapidReady ? JSON.stringify(note) : undefined;

  subs.forEach(function (sub) { sendTo(number, sub, payload); });
}

/* Manual test: push a canned note to every subscription for a number, ignoring
   the idle gate. Returns per-subscription results so a caller can see exactly
   what the push service reported. */
export function sendTest(number: string): Promise<Array<{ statusCode?: number; error?: string }>> {
  const subs = buffer.subsFor(number);
  const note = { title: 'Signal', body: 'Test notification', convId: '', incoming: true };
  buffer.addPending(number, note);
  const payload = vapidReady ? JSON.stringify(note) : undefined;
  return Promise.all(subs.map(function (sub) { return sendTo(number, sub, payload); }));
}
