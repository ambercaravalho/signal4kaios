/**
 * Network transport for Signal's servers (`signalBridge.net`).
 *
 * Every `*.signal.org` service presents a certificate from Signal's own root, which KaiOS's Gecko doesn't trust. On the phone, requests and WebSockets to those hosts therefore run over a raw `TCPSocket` with libsignal's pinned roots (native/libsignal-wasm/src/tls.rs). Other hosts, and environments without `TCPSocket`, keep using the platform's XHR and `WebSocket`.
 */

import { isLibsignalLoaded, libsignal } from '../../protocol/libsignal';
import { SIGNAL_USER_AGENT } from '../http';
import { Http1Client, HttpRequest, HttpResponse, parseHttpsUrl } from './http1';
import { Connector, TransportError } from './stream';
import { connectTcp, tcpSocketAvailable } from './tcp';
import { connectTls, TlsSession } from './tls-stream';
import { PinnedWebSocket } from './websocket';

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

const PROXY_PORT = 443;

export interface NetDeps {
  connectRaw: Connector;
  /** A platform-TLS stream to a Signal proxy, whose certificate is an ordinary public one. */
  connectSecure?: Connector;
  newSession: (host: string) => TlsSession;
  isPinnedHost: (host: string) => boolean;
  available: () => boolean;
}

/**
 * With a Signal proxy set, each connection opens TLS to the proxy and runs the pinned TLS to the Signal host inside it; the proxy forwards by the inner SNI, as Signal-TLS-Proxy does. The proxy sees only that a Signal host was reached, never the traffic.
 */
export function createNet(deps: NetDeps) {
  let proxyHost: string | null = null;

  const connectPinned: Connector = (host, port, timeoutMs) => {
    const proxy = proxyHost;
    if (!proxy) return connectTls(host, port, timeoutMs, deps.connectRaw, deps.newSession);
    const viaProxy: Connector = (_host, _port, t) => {
      if (!deps.connectSecure) return Promise.reject(new TransportError('network', 'proxy connections are not available'));
      return deps.connectSecure(proxy, PROXY_PORT, t).catch((e: any) => {
        throw new TransportError(e && e.kind === 'timeout' ? 'timeout' : 'network', `proxy ${proxy} did not answer: ${e && e.message}`);
      });
    };
    return connectTls(host, port, timeoutMs, viaProxy, deps.newSession);
  };
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

    /** The Signal proxy every pinned connection goes through, or null for direct connections. */
    proxy(): string | null {
      return proxyHost;
    },

    /** Use a Signal proxy (or none) from the next connection on; open keep-alive connections are dropped. */
    setProxy(host: string | null): void {
      const next = host || null;
      if (next === proxyHost) return;
      proxyHost = next;
      http.closeAll();
    },

    /** A `WebSocket`-shaped socket: pinned TLS for Signal hosts, the platform `WebSocket` otherwise. With a proxy set, a socket that would bypass it is refused. */
    openWebSocket(url: string, opts?: { timeoutMs?: number; headers?: Record<string, string> }): SocketLike {
      if (isPinnedUrl(url)) return new PinnedWebSocket(url, connectPinned, opts);
      if (proxyHost) throw new TransportError('network', 'a proxy is set but this socket would connect directly');
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
  connectRaw: (host, port, timeoutMs) => connectTcp(host, port, timeoutMs),
  connectSecure: (host, port, timeoutMs) => connectTcp(host, port, timeoutMs, true),
  newSession: (host) => new libsignal.TlsConn(host),
  isPinnedHost: (host) => libsignal.isPinnedTlsHost(host),
  available: () => isLibsignalLoaded() && tcpSocketAvailable(),
});
