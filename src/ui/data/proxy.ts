/* Signal proxy settings: the address the user chose and whether it's in use, kept app-wide in `s4k.config`. Links come from other people, so everything is checked as an untrusted hostname. */

import { net } from '../../engine/net/transport';
import { config } from './config';

const LINK = /^(?:https:\/\/signal\.tube\/#|sgnl:\/\/signal\.tube\/?\?(?:.*&)?host=)([^&#\s]+)/i;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A proxy hostname: dotted DNS labels with a letter-only top-level label, and not one of Signal's own hosts. */
export function validProxyHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return false;
  const signalHost = (base: string) => host === base || host.endsWith('.' + base);
  return !signalHost('signal.org') && !signalHost('signal.tube');
}

export function isProxyLink(text: string): boolean {
  return LINK.test((text || '').trim());
}

/** The proxy host from a `signal.tube` link or a typed address (`proxy.example.com`, optionally with `https://` or `:443`), or null. */
export function parseProxyLink(text: string): string | null {
  let s = (text || '').trim();
  const m = LINK.exec(s);
  if (m) {
    try {
      s = decodeURIComponent(m[1]);
    } catch {
      return null;
    }
  } else {
    s = s.replace(/^https:\/\//i, '').replace(/\/+$/, '');
  }
  s = s.toLowerCase().replace(/:443$/, '');
  return validProxyHost(s) ? s : null;
}

/** The proxy connections should use now, or null. */
export function activeProxy(): string | null {
  const host = config.proxyAddress();
  return config.proxyEnabled() && validProxyHost(host) ? host : null;
}

/** Point the network layer at the saved proxy setting. */
export function applyProxy(): void {
  net.setProxy(activeProxy());
}

export function saveProxy(address: string, enabled: boolean): void {
  config.set({ proxyAddress: address, proxyEnabled: enabled });
  applyProxy();
}
