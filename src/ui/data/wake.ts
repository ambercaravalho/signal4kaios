/* Background wake: KaiOS delivers `alarm` system messages to the ServiceWorker, which relays them to the open app so it can reconnect, or reopens Beacon when it was closed. */

import { S } from '../strings';
import { config } from './config';
import { dbg } from './log';
import { hasServiceWorker, scheduleAlarm } from './platform';

/** Cache Storage shared with `src/app/sw.js`; the name is kept from 2.0.x. */
export const WAKE_CACHE = 's4k-wake';
/** The `alarm` system message type `sw.js` relays to the app. */
export const WAKE_ALARM = 's4k-wake';
/** An alarm due at once, which lets `sw.js` bring the window forward: KaiOS allows that only while a system message is handled. */
export const FOCUS_ALARM = 's4k-focus';
/** The tag of the notification `sw.js` shows when the wake alarm finds Beacon closed. */
export const STOPPED_TAG = 's4k-stopped';
/** The message the hidden app and `sw.js` trade to stand in for the app's suspended timers. */
export const TICK = 's4k-tick';
const LEGACY_CREDENTIALS_KEY = '/__s4k_wake_cfg';
const FOCUS_DELAY_MS = 200;

/** The wake alarm's data. It carries the notice's wording, since the ServiceWorker has no strings of its own. */
export function wakeAlarmData(): { type: string; notice: { title: string; body: string } } {
  return { type: WAKE_ALARM, notice: { title: S.stoppedTitle, body: S.stoppedBody } };
}

/** Schedule the next wake alarm `ms` from now, replacing the pending one. */
export function scheduleWake(ms: number, now = Date.now()): Promise<unknown> {
  return scheduleAlarm(new Date(now + ms), wakeAlarmData());
}

/** Bring Beacon's window to the foreground from the background, for an incoming call. */
export function bringToFront(): void {
  scheduleAlarm(new Date(Date.now() + FOCUS_DELAY_MS), { type: FOCUS_ALARM }).catch((e) => dbg('wake: could not ask to come forward ' + (e && e.message)));
}

/** Beacon is running again, so the notice saying it stopped is out of date. */
export function closeStoppedNotice(): void {
  if (!hasServiceWorker() || !navigator.serviceWorker) return;
  navigator.serviceWorker.ready
    .then((reg) => (reg.getNotifications ? reg.getNotifications({ tag: STOPPED_TAG }) : []))
    .then((list) => list.forEach((n) => n.close()))
    .catch((e) => dbg('wake: could not close the stopped notice ' + (e && e.message)));
}

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
