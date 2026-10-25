/* Direct calls from the gateway to signal-cli-rest-api over the internal network (not the app-facing proxy): listing linked accounts and starting a device link. Responses are untrusted and validated here. */

import { config } from './config';

/* /v1/accounts returns ["+1..."] up to signal-cli-rest-api 0.101 and [{ number, aci }] after it. Accounts without a phone number are skipped: the app addresses everything by number. */
export function parseAccounts(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  list.forEach(function (item: unknown) {
    let n: unknown = item;
    if (item && typeof item === 'object') n = (item as { number?: unknown }).number;
    if (typeof n === 'string' && /^\+\d{4,20}$/.test(n) && out.indexOf(n) === -1) out.push(n);
  });
  return out;
}

export function listAccounts(): Promise<string[]> {
  return fetch(config.signalCliUrl + '/v1/accounts').then(function (r) {
    if (!r.ok) throw new Error('signal-cli-rest-api answered HTTP ' + r.status);
    return r.json();
  }).then(parseAccounts);
}

/* Starts linking a new device and returns its sgnl://linkdevice URI. In json-rpc mode signal-cli-rest-api returns at once and finishes the link in the background once the URI is scanned. */
export function deviceLinkUri(deviceName: string): Promise<string> {
  const url = config.signalCliUrl + '/v1/qrcodelink/raw?device_name=' + encodeURIComponent(deviceName);
  return fetch(url).then(function (r) {
    return r.json().then(function (body: unknown) {
      const b = (body && typeof body === 'object' ? body : {}) as { device_link_uri?: unknown; error?: unknown };
      if (!r.ok) {
        throw new Error('signal-cli-rest-api answered HTTP ' + r.status +
          (typeof b.error === 'string' ? ': ' + b.error : ''));
      }
      if (typeof b.device_link_uri !== 'string' || b.device_link_uri.indexOf('sgnl://linkdevice?') !== 0) {
        throw new Error('signal-cli-rest-api returned no device link');
      }
      return b.device_link_uri;
    });
  });
}
