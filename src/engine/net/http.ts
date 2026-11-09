/* Signal service endpoints and the HTTP function shapes the engine receives from the app (src/ui/data/http.ts). */

export const DEFAULT_SIGNAL_SERVER = 'https://chat.signal.org';
export const DEFAULT_SIGNAL_WS = 'wss://chat.signal.org';
export const DEFAULT_SIGNAL_CDN = 'https://cdn.signal.org';
export const DEFAULT_STORAGE_SERVER = 'https://storage.signal.org';

export const SIGNAL_USER_AGENT = 'Signal4KaiOS/2.5.0';

/** Signal-Desktop config/production.json `cdn` map. */
export const SIGNAL_CDNS: Record<number, string> = {
  0: 'https://cdn.signal.org',
  2: 'https://cdn2.signal.org',
  3: 'https://cdn3.signal.org',
};

export type SignalHttpJsonFn = (
  method: string,
  path: string,
  body: unknown,
  opts?: {
    baseUrl?: string;
    noAuth?: boolean;
    basicAuth?: { username: string; password: string };
    headers?: Record<string, string>;
    timeout?: number;
    binary?: boolean;
  }
) => Promise<any>;

export type SignalHttpBinaryFn = (
  method: string,
  url: string,
  body?: Uint8Array | null,
  headers?: Record<string, string>,
  timeout?: number
) => Promise<Uint8Array>;

/** Raw CDN request that also exposes the status and `Location` header (resumable CDN2 uploads). */
export type SignalHttpRawFn = (
  method: string,
  url: string,
  body?: Uint8Array | null,
  headers?: Record<string, string>,
  timeout?: number
) => Promise<{ status: number; body: Uint8Array; location: string | null }>;
