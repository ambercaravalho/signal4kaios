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

/* Called by the upstream receiver for every incoming frame. */
export function onIncoming(number: string, text: string): void {
  const note = toNote(text);
  if (!note || !note.incoming) return;

  // The app is open for this number; it will show its own notification.
  if (config.pushWhenIdleOnly && clients.count(number) > 0) return;

  const subs = buffer.subsFor(number);
  if (!subs.length) return;

  // Queue for the tickle fallback (SW fetches /v1/push/pending when it can't
  // read a payload), then attempt a payload push to every subscription.
  buffer.addPending(number, note);
  const payload = JSON.stringify(note);

  subs.forEach(function (sub) {
    const options = vapidReady ? undefined : { TTL: 3600 };
    webpush.sendNotification(sub as webpush.PushSubscription, payload, options)
      .catch(function (err: any) {
        const status = err && err.statusCode;
        if (status === 404 || status === 410) {
          const endpoint = (sub as { endpoint?: string }).endpoint;
          if (endpoint) buffer.removeSubByEndpoint(endpoint);
          log.warn('push: pruned expired subscription for ' + maskNumber(number));
        } else {
          log.error('push: send failed for ' + maskNumber(number), err);
        }
      });
  });
}
