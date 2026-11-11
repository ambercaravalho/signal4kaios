/* Background wake: KaiOS delivers `alarm` system messages to the ServiceWorker, which relays them to the open app so it can reconnect. */

import { config } from './config';
import { dbg } from './log';
import { hasServiceWorker } from './platform';

/** Cache Storage shared with `src/app/sw.js`; the name is kept from 2.0.x. */
export const WAKE_CACHE = 's4k-wake';
/** The `alarm` system message type `sw.js` relays to the app. */
export const WAKE_ALARM = 's4k-wake';
const LEGACY_CREDENTIALS_KEY = '/__s4k_wake_cfg';

function ensurePermission(): Promise<string> {
  if (typeof Notification === 'undefined') return Promise.resolve('unsupported');
  if (Notification.permission === 'granted' || Notification.permission === 'denied') return Promise.resolve(Notification.permission);
  try {
    const r = Notification.requestPermission();
    if (r && typeof r.then === 'function') return r;
  } catch {
    // callback-only form
  }
  return Promise.resolve(Notification.permission || 'default');
}

/** 2.0.x cached the device login in Cache Storage for a closed-app check; nothing reads it any more. */
function dropLegacyCredentials(): Promise<void> {
  if (typeof caches === 'undefined') return Promise.resolve();
  // SECURITY-REVIEW: removes the device password 2.0.x stored for the ServiceWorker.
  return caches
    .open(WAKE_CACHE)
    .then((cache) => cache.delete(LEGACY_CREDENTIALS_KEY))
    .then(
      () => {},
      () => {}
    );
}

export function setupWake(): Promise<void> {
  if (!hasServiceWorker() || !config.isConfigured()) return dropLegacyCredentials();
  return dropLegacyCredentials()
    .then(ensurePermission)
    .then((perm) => {
      dbg('wake: notification permission ' + perm);
      return navigator.serviceWorker.ready;
    })
    .then((reg) => {
      if (!reg.systemMessageManager) return;
      return reg.systemMessageManager.subscribe('alarm').then(() => dbg('wake: alarm messages subscribed'));
    })
    .catch((e) => dbg('wake: setup failed ' + (e && e.message)));
}
