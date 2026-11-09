/**
 * Network transport for Signal's servers (`signalBridge.net`).
 *
 * Every `*.signal.org` service presents a certificate from Signal's own root, which KaiOS's Gecko doesn't trust. On the phone, requests and WebSockets to those hosts therefore run over a raw `TCPSocket` with libsignal's pinned roots (native/libsignal-wasm/src/tls.rs). Other hosts, and environments without `TCPSocket`, keep using the platform's XHR and `WebSocket`.
 */

import { isLibsignalLoaded, libsignal } from '../../protocol/libsignal';
import { SIGNAL_USER_AGENT } from '../http';
import { Http1Client, HttpRequest, HttpResponse, parseHttpsUrl } from './http1';
import { Connector } from './stream';
import { connectTcp, tcpSocketAvailable } from './tcp';
import { connectTls, TlsSession } from './tls-stream';
import { PinnedWebSocket } from './websocket';

export { TransportError } from './stream';
export type { HttpRequest, HttpResponse } from './http1';

/** The `WebSocket` subset both the platform socket and `PinnedWebSocket` provide. */
export interface SocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: ArrayBuffer | ArrayBufferView | string): void;
  close(code?: number, reason?: string): void;
  onopen: ((evt: any) => void) | null;
  onmessage: ((evt: { data: any }) => void) | null;
  onerror: ((evt: any) => void) | null;
  onclose: ((evt: { code: number; reason: string; wasClean: boolean }) => void) | null;
}

export const SOCKET_OPEN = 1;

export interface NetDeps {
  connectRaw: Connector;
  newSession: (host: string) => TlsSession;
  isPinnedHost: (host: string) => boolean;
  available: () => boolean;
}

export function createNet(deps: NetDeps) {
  const connectPinned: Connector = (host, port, timeoutMs) => connectTls(host, port, timeoutMs, deps.connectRaw, deps.newSession);
  const http = new Http1Client(connectPinned, { userAgent: SIGNAL_USER_AGENT });

  function isPinnedUrl(url: string): boolean {
    if (!deps.available()) return false;
    try {
      const { host } = parseHttpsUrl(url, ['https', 'wss']);
      return deps.isPinnedHost(host);
    } catch {
      return false;
    }
  }

  return {
    /** True when this device can reach Signal's servers through the pinned TLS client. */
    pinnedTlsAvailable(): boolean {
      return deps.available();
    },

    isPinnedUrl,

    /** A `WebSocket`-shaped socket: pinned TLS for Signal hosts, the platform `WebSocket` otherwise. */
    openWebSocket(url: string, opts?: { timeoutMs?: number; headers?: Record<string, string> }): SocketLike {
      if (isPinnedUrl(url)) return new PinnedWebSocket(url, connectPinned, opts);
      const sock = new WebSocket(url);
      sock.binaryType = 'arraybuffer';
      return sock as unknown as SocketLike;
    },

    /** One HTTPS request to a Signal host over pinned TLS. Redirects are returned to the caller, not followed. */
    request(req: HttpRequest): Promise<HttpResponse> {
      return http.request(req);
    },

    /** Drops idle keep-alive connections, e.g. after the network changes. */
    reset(): void {
      http.closeAll();
    },
  };
}

export type SignalNet = ReturnType<typeof createNet>;

export const net: SignalNet = createNet({
  connectRaw: connectTcp,
  newSession: (host) => new libsignal.TlsConn(host),
  isPinnedHost: (host) => libsignal.isPinnedTlsHost(host),
  available: () => isLibsignalLoaded() && tcpSocketAvailable(),
});
