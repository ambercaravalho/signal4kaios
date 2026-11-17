/* HTTP to Signal's servers. Signal's certificates chain to Signal's own root, which KaiOS doesn't trust, so `*.signal.org` requests go through the engine's pinned TLS client over `tcp-socket`. Other hosts, and environments without `TCPSocket`, use mozSystem XHR (privileged app: no CORS). A 401 for the active device means it was unlinked from the phone; `onUnlinked` fires once. */

import { isClockError, net } from '../../engine/net/transport';
import type { HostHttpOptions, HostRawResponse } from '../../engine/host';
import { config } from './config';
import { dbg } from './log';
import { mozSystemXhr } from './platform';

const MAX_REDIRECTS = 3;

export interface HttpError extends Error {
  kind?: 'network' | 'timeout' | 'http' | 'clock';
  status?: number;
  body?: any;
}

interface Res {
  status: number;
  body: Uint8Array;
  header(name: string): string | null;
}

let unlinkedFired = false;
let unlinkedHandler: (() => void) | null = null;

export function onUnlinked(fn: () => void): void {
  unlinkedHandler = fn;
}

function netError(message: string, kind: 'network' | 'timeout' | 'clock'): HttpError {
  const err: HttpError = new Error(message);
  err.kind = kind;
  return err;
}

function tooLarge(): HttpError {
  return new Error('response is too large');
}

function encodeBasicAuth(username: string, password: string): string {
  // SECURITY-REVIEW: Signal device credentials go only to Signal's servers over HTTPS Basic auth and are never logged.
  return 'Basic ' + btoa(username + ':' + password);
}

function xhrSend(method: string, url: string, headers: Record<string, string>, body: BodyInit | Uint8Array | null, timeout: number, maxBytes?: number, onProgress?: (loaded: number) => void): Promise<Res> {
  return new Promise((resolve, reject) => {
    const xhr = mozSystemXhr() || new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.responseType = 'arraybuffer';
    for (const k of Object.keys(headers)) xhr.setRequestHeader(k, headers[k]);
    // `xhr.timeout` caps the whole transfer; this times out only when nothing has moved for `timeout`, like the pinned client.
    let watchdog = setTimeout(expire, timeout);
    function expire(): void {
      xhr.abort();
      reject(netError('timeout', 'timeout'));
    }
    const progress = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(expire, timeout);
    };
    xhr.onprogress = (e: ProgressEvent) => {
      if (maxBytes && e.loaded > maxBytes) {
        clearTimeout(watchdog);
        xhr.abort();
        reject(tooLarge());
        return;
      }
      progress();
      if (onProgress) onProgress(e.loaded);
    };
    if (xhr.upload) xhr.upload.onprogress = progress;
    xhr.onload = () => {
      clearTimeout(watchdog);
      if (maxBytes && xhr.response && xhr.response.byteLength > maxBytes) return reject(tooLarge());
      resolve({
        status: xhr.status,
        body: xhr.response ? new Uint8Array(xhr.response) : new Uint8Array(0),
        header: (name) => xhr.getResponseHeader(name),
      });
    };
    xhr.onerror = () => {
      clearTimeout(watchdog);
      reject(netError('network', 'network'));
    };
    if (body != null) xhr.send(body as any);
    else xhr.send();
  });
}

/* Redirects are followed here; one that leaves Signal's hosts drops the Authorization header and continues over XHR. */
function pinnedSend(method: string, url: string, headers: Record<string, string>, body: Uint8Array | null, timeout: number, redirects: number, maxBytes?: number): Promise<Res> {
  return net.request({ method, url, headers, body, timeoutMs: timeout, maxResponseBytes: maxBytes }).then(
    (res) => {
      const location = res.headers.location;
      if (res.status >= 300 && res.status < 400 && res.status !== 304 && location && redirects < MAX_REDIRECTS) {
        const next = new URL(location, url).toString();
        const nextMethod = res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST') ? 'GET' : method;
        const nextBody = nextMethod === 'GET' ? null : body;
        if (net.isPinnedUrl(next)) return pinnedSend(nextMethod, next, headers, nextBody, timeout, redirects + 1, maxBytes);
        const offHost: Record<string, string> = {};
        for (const k of Object.keys(headers)) if (k.toLowerCase() !== 'authorization') offHost[k] = headers[k];
        return xhrSend(nextMethod, next, offHost, nextBody, timeout, maxBytes);
      }
      return {
        status: res.status,
        body: res.body,
        header: (name: string) => {
          const v = res.headers[String(name).toLowerCase()];
          return v === undefined ? null : v;
        },
      };
    },
    (e: any) => {
      if (e && e.kind === 'timeout') throw netError('timeout', 'timeout');
      if (e && e.kind === 'protocol' && /too large/.test(e.message)) throw tooLarge();
      if (e && e.kind === 'tls' && isClockError(String(e.message))) throw netError('clock', 'clock');
      dbg('http: pinned TLS ' + method + ' failed: ' + (e && e.message));
      throw netError('network', 'network');
    }
  );
}

function isSignalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'signal.org' || host.endsWith('.signal.org');
  } catch {
    return false;
  }
}

/* With a Signal proxy set, nothing for Signal's hosts may go out directly: without the pinned client the request fails instead of falling back to XHR. */
function send(method: string, url: string, headers: Record<string, string>, body: string | Uint8Array | null, timeout: number, maxBytes?: number): Promise<Res> {
  if (net.isPinnedUrl(url)) {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    return pinnedSend(method, url, headers, bytes || null, timeout, 0, maxBytes);
  }
  if (net.proxy() && isSignalUrl(url)) return Promise.reject(netError('network', 'network'));
  return xhrSend(method, url, headers, body, timeout, maxBytes);
}

/** A JSON request to a Signal service path. Resolves to the parsed body (or a Blob with `binary`); rejects with an `HttpError`. */
function request(method: string, path: string, body: unknown, opts: HostHttpOptions & { binary?: boolean } = {}): Promise<any> {
  const base = (opts.baseUrl || config.serverUrl()).replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  let isActiveToken = false;
  if (opts.basicAuth && opts.basicAuth.username) {
    headers.Authorization = encodeBasicAuth(opts.basicAuth.username, opts.basicAuth.password || '');
  } else if (!opts.noAuth && config.isConfigured()) {
    headers.Authorization = encodeBasicAuth(config.login(), config.deviceToken());
    isActiveToken = true;
  }
  if (opts.headers) for (const k of Object.keys(opts.headers)) headers[k] = opts.headers[k];
  headers['X-Signal-Agent'] = 'OWD';
  let payload: string | Uint8Array | null = null;
  if (body instanceof Uint8Array) {
    payload = body;
  } else if (body != null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  return send(method, base + path, headers, payload, opts.timeout || 15000).then(
    (res) => {
      if (res.status >= 200 && res.status < 300) {
        if (opts.binary) return new Blob([res.body as BlobPart]);
        const text = res.body.length ? new TextDecoder().decode(res.body) : '';
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
      let parsed: any = null;
      try {
        parsed = JSON.parse(new TextDecoder().decode(res.body));
      } catch {
        // non-JSON error body
      }
      dbg('http fail ' + method + ' ' + path + ' -> ' + res.status);
      if (res.status === 401 && isActiveToken && !unlinkedFired && unlinkedHandler) {
        unlinkedFired = true;
        unlinkedHandler();
      }
      const err: HttpError = new Error('HTTP ' + res.status + (parsed && parsed.error ? ': ' + parsed.error : ''));
      err.kind = 'http';
      err.status = res.status;
      err.body = parsed;
      throw err;
    },
    (e: HttpError) => {
      dbg('http ' + (e.kind || 'error') + ' ' + method + ' ' + path);
      throw e;
    }
  );
}

/** A raw binary request (CDN attachments, Storage Service protobufs). Rejects on non-2xx with `status` set. */
function rawRequest(method: string, url: string, body?: Uint8Array | null, headers?: Record<string, string>, timeout?: number, maxBytes?: number): Promise<HostRawResponse> {
  return send(method, url, headers || {}, body || null, timeout || 60000, maxBytes).then((res) => {
    if (res.status >= 200 && res.status < 300) return { status: res.status, body: res.body, location: res.header('Location'), range: res.header('Content-Range') };
    const err: HttpError = new Error('HTTP ' + res.status);
    err.kind = 'http';
    err.status = res.status;
    throw err;
  });
}

function rawBinary(method: string, url: string, body?: Uint8Array | null, headers?: Record<string, string>, timeout?: number, maxBytes?: number): Promise<Uint8Array> {
  return rawRequest(method, url, body, headers, timeout, maxBytes).then((res) => res.body);
}

export interface ExternalOptions {
  body?: string;
  headers?: Record<string, string>;
  maxBytes: number;
  timeout?: number;
  onProgress?: (loaded: number) => void;
}

/** A request to a host other than Signal's (Beacon's releases, the phone's install service), with download progress. Rejects on non-2xx with `status` set. */
function external(method: 'GET' | 'POST', url: string, opts: ExternalOptions): Promise<Uint8Array> {
  if (net.isPinnedUrl(url) || isSignalUrl(url)) return Promise.reject(netError('network', 'network'));
  return xhrSend(method, url, opts.headers || {}, opts.body == null ? null : opts.body, opts.timeout || 30000, opts.maxBytes, opts.onProgress).then((res) => {
    if (res.status >= 200 && res.status < 300) return res.body;
    const err: HttpError = new Error('HTTP ' + res.status);
    err.kind = 'http';
    err.status = res.status;
    throw err;
  });
}

export const http = { request, rawRequest, rawBinary, external };
