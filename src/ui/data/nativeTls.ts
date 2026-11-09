/* Whether Gecko trusts Signal's root certificate, which `scripts/signal-cert.mjs` adds on a rooted phone. When it does, requests to Signal's attachment CDNs use the platform's TLS (mozSystem XHR) instead of the in-app client, which takes the TLS work off the app's main thread. Nothing else moves: see `useBuiltIn`. */

import { SIGNAL_CDNS } from '../../engine/net/http';
import { dbg } from './log';

export type NativeTlsState = 'unknown' | 'trusted' | 'untrusted';

const PROBE_TIMEOUT_MS = 10000;
const CDN_HOSTS = Object.values(SIGNAL_CDNS).map((u) => new URL(u).host);

let state: NativeTlsState = 'unknown';
let pending: Promise<boolean> | null = null;
const listeners = new Set<(s: NativeTlsState) => void>();

function setState(next: NativeTlsState): void {
  if (next === state) return;
  state = next;
  dbg('native TLS: ' + next);
  for (const fn of listeners) fn(next);
}

export function nativeTlsState(): NativeTlsState {
  return state;
}

export function onNativeTlsChange(fn: (s: NativeTlsState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isCdnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.port && CDN_HOSTS.includes(u.host);
  } catch {
    return false;
  }
}

/**
 * True when `url` should use the platform's TLS.
 * SECURITY-REVIEW: the platform trusts every public CA, not only Signal's pinned roots, so only CDN traffic may take this path. Attachments are end-to-end encrypted and MAC-checked, and uploads carry one-time upload credentials. Chat, Storage Service, and provisioning carry account credentials or keys and always stay on the pinned client.
 */
export function useBuiltIn(url: string): boolean {
  return state === 'trusted' && isCdnUrl(url);
}

/** Runs `builtIn`; if it fails at the network level (e.g. the certificate was removed), stops using the platform's TLS and runs `pinned` instead. */
export function withFallback<T>(builtIn: () => Promise<T>, pinned: () => Promise<T>): Promise<T> {
  return builtIn().catch((e: any) => {
    if (!e || e.kind !== 'network') throw e;
    dbg('native TLS: request failed, using pinned TLS');
    setState('untrusted');
    return pinned();
  });
}

/** One unauthenticated request to Signal's CDN over the platform's TLS. Any HTTP status means Gecko accepted Signal's certificate. */
export function probe(): Promise<boolean> {
  if (pending) return pending;
  pending = new Promise<boolean>((resolve) => {
    let xhr: XMLHttpRequest;
    try {
      xhr = new (XMLHttpRequest as any)({ mozSystem: true });
      xhr.open('HEAD', SIGNAL_CDNS[0] + '/', true);
      xhr.timeout = PROBE_TIMEOUT_MS;
    } catch {
      resolve(false);
      return;
    }
    xhr.onload = () => resolve(xhr.status > 0);
    xhr.onerror = () => resolve(false);
    xhr.ontimeout = () => resolve(false);
    xhr.send();
  }).then((ok) => {
    pending = null;
    setState(ok ? 'trusted' : 'untrusted');
    return ok;
  });
  return pending;
}

export function installProbeHandlers(): void {
  if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('online', () => void probe());
}
