/* Signal service endpoints and the HTTP function shapes the engine receives from the app (src/ui/data/http.ts). */

export const DEFAULT_SIGNAL_SERVER = 'https://chat.signal.org';
export const DEFAULT_SIGNAL_WS = 'wss://chat.signal.org';
export const DEFAULT_SIGNAL_CDN = 'https://cdn.signal.org';
export const DEFAULT_STORAGE_SERVER = 'https://storage.signal.org';

export const SIGNAL_USER_AGENT = 'Signal4KaiOS/2.10.0';

/** Signal-Desktop config/production.json `cdn` map. */
export const SIGNAL_CDNS: Record<number, string> = {
  0: 'https://cdn.signal.org',
  2: 'https://cdn2.signal.org',
  3: 'https://cdn3.signal.org',
};

export interface BasicAuth {
  username: string;
  password: string;
}

/** SECURITY-REVIEW: the linked device's chat-server login, `aci.deviceId` with the device password; send it only to Signal's chat server. */
export function accountBasicAuth(acc: { aci: string; deviceId: number; password: string }): BasicAuth {
  return { username: `${acc.aci}.${acc.deviceId}`, password: acc.password };
}

/** A decoded JSON response: every field is untrusted until checked. */
export type JsonObject = Record<string, unknown>;

/** `v` when it is a JSON object, else null. */
export function asObject(v: unknown): JsonObject | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : null;
}

export type SignalHttpJsonFn = (
  method: string,
  path: string,
  /** Sent as JSON, except bytes, which go as-is with the `Content-Type` from `headers`. */
  body: unknown,
  opts?: {
    baseUrl?: string;
    noAuth?: boolean;
    basicAuth?: BasicAuth;
    headers?: Record<string, string>;
    timeout?: number;
    binary?: boolean;
  }
) => Promise<unknown>;

export type SignalHttpBinaryFn = (
  method: string,
  url: string,
  body?: Uint8Array | null,
  headers?: Record<string, string>,
  timeout?: number
) => Promise<Uint8Array>;

/** Raw CDN request that also exposes the status and the `Location` (resumable CDN2 uploads) and `Content-Range` (resumable downloads) headers. */
export type SignalHttpRawFn = (
  method: string,
  url: string,
  body?: Uint8Array | null,
  headers?: Record<string, string>,
  timeout?: number
) => Promise<{ status: number; body: Uint8Array; location: string | null; range?: string | null }>;
