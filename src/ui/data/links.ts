/* Signal links that people share or show as QR codes. They come from other people, so each kind is matched strictly and anything else is left to the browser. */

import { isProxyLink } from './proxy';

export type SignalLink = { kind: 'group' | 'proxy' | 'username'; url: string } | { kind: 'phone'; number: string };

const GROUP = /^(https|sgnl):\/\/signal\.group\/#/;
const USERNAME = /^(https|sgnl):\/\/signal\.me\/?#eu\/[A-Za-z0-9_+/=-]+$/;
const PHONE = /^(?:https|sgnl):\/\/signal\.me\/?#p\/(\+?\d{6,15})$/;

/** What a Signal link points to, or null when it isn't one. */
export function signalLink(text: string): SignalLink | null {
  const url = (text || '').trim();
  if (GROUP.test(url)) return { kind: 'group', url };
  if (isProxyLink(url)) return { kind: 'proxy', url };
  if (USERNAME.test(url)) return { kind: 'username', url };
  const m = PHONE.exec(url);
  if (m) return { kind: 'phone', number: m[1].charAt(0) === '+' ? m[1] : '+' + m[1] };
  return null;
}
