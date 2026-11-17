/* Screen lock: a PIN that covers the app at launch and after it's been in the background. It only hides the app; nothing on the phone is encrypted with the PIN. */

import { fromBase64, toBase64 } from '../../engine/bytes';
import { config, type ScreenLockConfig } from './config';

export const PIN_MIN = 4;
export const PIN_MAX = 8;
/** Seconds in the background before the app locks; 0 locks as soon as it's hidden. */
export const LOCK_AFTER_OPTIONS = [0, 60, 300, 900, 1800, 3600];
const DEFAULT_LOCK_AFTER = 60;
const PBKDF2_ITERATIONS = 100000;
const FREE_ATTEMPTS = 3;
const FIRST_DELAY_MS = 30000;
const MAX_DELAY_MS = 15 * 60000;
/** How much of a wait may pass between saves of what's left. */
const SAVE_EVERY_MS = 5000;

/** Time that only moves forward while Beacon runs; changing the phone's clock doesn't move it. */
const clock = (): number => performance.now();

export interface PinHash {
  salt: string;
  hash: string;
  iterations: number;
}

export function validPin(pin: string): boolean {
  return /^\d+$/.test(pin) && pin.length >= PIN_MIN && pin.length <= PIN_MAX;
}

// SECURITY-REVIEW: the PIN itself is never stored or logged; s4k.config keeps only this salted PBKDF2-SHA-256 hash.
export async function hashPin(pin: string, salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16)), iterations = PBKDF2_ITERATIONS): Promise<PinHash> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations }, key, 256);
  return { salt: toBase64(salt), hash: toBase64(new Uint8Array(bits)), iterations };
}

export async function verifyPin(pin: string, stored: PinHash): Promise<boolean> {
  if (!validPin(pin)) return false;
  const a = fromBase64((await hashPin(pin, fromBase64(stored.salt), stored.iterations)).hash);
  const b = fromBase64(stored.hash);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Whether coming back after being hidden since `hiddenAt` (on the same clock as `now`) needs the PIN. */
export function lockDue(lockAfterSecs: number, hiddenAt: number | null, now: number): boolean {
  return hiddenAt !== null && now - hiddenAt >= lockAfterSecs * 1000;
}

/** How long to wait after this many wrong PINs in a row: the first few are free, then the wait doubles up to 15 minutes. */
export function retryDelayMs(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(FIRST_DELAY_MS * Math.pow(2, failures - FREE_ATTEMPTS), MAX_DELAY_MS);
}

/** A wait as `m:ss`, rounded up so it never reads 0:00 while still waiting. */
export function waitLabel(ms: number): string {
  const secs = Math.max(0, Math.ceil(ms / 1000));
  const s = secs % 60;
  return Math.floor(secs / 60) + ':' + (s < 10 ? '0' : '') + s;
}

export function enabled(): boolean {
  return !!config.screenLock();
}

export function lockAfter(): number {
  const s = config.screenLock();
  return s ? s.lockAfter : DEFAULT_LOCK_AFTER;
}

export async function enable(pin: string, after = DEFAULT_LOCK_AFTER): Promise<void> {
  if (!validPin(pin)) throw new Error('PIN must be 4 to 8 digits');
  const h = await hashPin(pin);
  const s: ScreenLockConfig = { ...h, lockAfter: after, failures: 0, waitLeftMs: 0 };
  anchor = null;
  config.set({ screenLock: s });
}

export function disable(): void {
  config.set({ screenLock: undefined });
}

export function setLockAfter(secs: number): void {
  const s = config.screenLock();
  if (s) config.set({ screenLock: { ...s, lockAfter: secs } });
}

/** The saved wait as of `at` on the running clock; a restart starts again from what was saved. */
let anchor: { at: number; left: number } | null = null;

function saveLeft(s: ScreenLockConfig, left: number, now: number): void {
  anchor = left ? { at: now, left } : null;
  config.set({ screenLock: { ...s, waitLeftMs: left } });
}

/** How long until the next PIN may be tried; 0 when it can be tried now. The wait passes only while Beacon runs, so setting the clock forward doesn't end it. */
export function waitLeft(now = clock(), save = false): number {
  const s = config.screenLock();
  if (!s || !s.waitLeftMs) {
    anchor = null;
    return 0;
  }
  if (!anchor || now < anchor.at) anchor = { at: now, left: s.waitLeftMs };
  const left = Math.max(0, anchor.left - (now - anchor.at));
  if (save || !left || s.waitLeftMs - left >= SAVE_EVERY_MS) saveLeft(s, left, now);
  return left;
}

/** Check a PIN, counting wrong ones so repeated guesses have to wait. Wrong guesses and what's left of a wait are remembered across restarts. */
export async function check(pin: string, now = clock()): Promise<{ ok: boolean; waitMs: number }> {
  const left = waitLeft(now, true);
  const s = config.screenLock();
  if (!s) return { ok: true, waitMs: 0 };
  if (left) return { ok: false, waitMs: left };
  if (await verifyPin(pin, s)) {
    if (s.failures || s.waitLeftMs) saveLeft({ ...s, failures: 0 }, 0, now);
    return { ok: true, waitMs: 0 };
  }
  const failures = s.failures + 1;
  const delay = retryDelayMs(failures);
  saveLeft({ ...s, failures }, delay, now);
  return { ok: false, waitMs: delay };
}

let locked = false;
let hiddenAt: number | null = null;
const listeners = new Set<() => void>();

function setLocked(v: boolean): void {
  if (locked === v) return;
  locked = v;
  for (const fn of Array.from(listeners)) fn();
}

export function isLocked(): boolean {
  return locked;
}

export function lockNow(): void {
  if (enabled()) setLocked(true);
}

export function unlock(): void {
  setLocked(false);
}

export function onLockChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The app was hidden or shown again: lock at once for "immediately", or on return once the wait has passed. */
export function visibilityChanged(hidden: boolean, now = clock()): void {
  if (!enabled()) {
    hiddenAt = null;
    return;
  }
  if (hidden) {
    waitLeft(now, true);
    if (hiddenAt === null) hiddenAt = now;
    if (lockAfter() === 0) setLocked(true);
    return;
  }
  if (lockDue(lockAfter(), hiddenAt, now)) setLocked(true);
  hiddenAt = null;
}

/** Lock at launch when a PIN is set, and follow the app going to and from the background. */
export function install(): void {
  if (enabled()) setLocked(true);
  document.addEventListener('visibilitychange', () => visibilityChanged(document.hidden));
}
