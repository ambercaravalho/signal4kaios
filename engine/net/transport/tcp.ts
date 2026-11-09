/** KaiOS raw `TCPSocket` (the app's `tcp-socket` permission) as a `ByteStream`. */

import { ByteStream, TransportError } from './stream';

interface GeckoTcpSocket {
  readyState: string;
  send(data: ArrayBuffer, byteOffset?: number, byteLength?: number): boolean;
  close(): void;
  onopen: ((evt: unknown) => void) | null;
  ondata: ((evt: { data: ArrayBuffer }) => void) | null;
  ondrain: ((evt: unknown) => void) | null;
  onerror: ((evt: { name?: string; message?: string; data?: { name?: string; message?: string } }) => void) | null;
  onclose: ((evt: unknown) => void) | null;
}

type OpenFn = (host: string, port: number, options: { binaryType: 'arraybuffer'; useSecureTransport: false }) => GeckoTcpSocket;

/** Gecko 123 exposes the `TCPSocket` constructor; KaiOS 3.x builds may only have the older `navigator.mozTCPSocket.open`. */
function socketOpener(): OpenFn | null {
  const g = globalThis as any;
  if (typeof g.TCPSocket === 'function') {
    return (host, port, options) => new g.TCPSocket(host, port, options);
  }
  const moz = g.navigator && g.navigator.mozTCPSocket;
  if (moz && typeof moz.open === 'function') {
    return (host, port, options) => moz.open(host, port, options);
  }
  return null;
}

export function tcpSocketAvailable(): boolean {
  return socketOpener() !== null;
}

export function connectTcp(host: string, port: number, timeoutMs: number): Promise<ByteStream> {
  const open = socketOpener();
  if (!open) return Promise.reject(new TransportError('network', 'TCPSocket is not available'));

  return new Promise((resolve, reject) => {
    let settled = false;
    let closed = false;
    let sock: GeckoTcpSocket;
    try {
      sock = open(host, port, { binaryType: 'arraybuffer', useSecureTransport: false });
    } catch (e) {
      reject(new TransportError('network', `could not open a socket: ${(e as Error).message}`));
      return;
    }

    const stream: ByteStream = {
      write(data) {
        if (closed) return true;
        // TCPSocket takes an ArrayBuffer slice; copy so callers may reuse `data`.
        const copy = data.slice();
        return sock.send(copy.buffer, 0, copy.byteLength);
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          sock.close();
        } catch {
          // already closed
        }
        const cb = stream.onClose;
        stream.onClose = null;
        if (cb) cb(null);
      },
      onData: null,
      onClose: null,
      onDrain: null,
    };

    const finish = (err: TransportError | null) => {
      if (closed) return;
      closed = true;
      const cb = stream.onClose;
      stream.onClose = null;
      if (cb) cb(err);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      closed = true;
      try {
        sock.close();
      } catch {
        // ignore
      }
      reject(new TransportError('timeout', `connecting to ${host} timed out`));
    }, timeoutMs);

    sock.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(stream);
    };
    sock.ondata = (evt) => {
      if (stream.onData) stream.onData(new Uint8Array(evt.data));
    };
    sock.ondrain = () => {
      if (stream.onDrain) stream.onDrain();
    };
    sock.onerror = (evt) => {
      const info = (evt && (evt.data || evt)) || {};
      const err = new TransportError('network', `socket error${info.name ? ` (${info.name})` : ''}`);
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        closed = true;
        reject(err);
        return;
      }
      finish(err);
    };
    sock.onclose = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        closed = true;
        reject(new TransportError('network', `connection to ${host} closed`));
        return;
      }
      finish(null);
    };
  });
}
