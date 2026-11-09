/** Pinned TLS (libsignal wasm `TlsConn`) layered over a raw `ByteStream`. */

import { ByteStream, Connector, TransportError } from './stream';

/** The `TlsConn` surface from native/libsignal-wasm/src/tls.rs. */
export interface TlsSession {
  feed(data: Uint8Array): void;
  takeOutgoing(): Uint8Array;
  write(data: Uint8Array): void;
  read(): Uint8Array;
  isHandshaking(): boolean;
  peerClosed(): boolean;
  closeNotify(): void;
  free(): void;
}

function tlsError(e: unknown): TransportError {
  const err = e as Error;
  if (err && err.name === 'TlsHostNotAllowed') return new TransportError('tls', err.message);
  return new TransportError('tls', `secure connection failed: ${(err && err.message) || String(e)}`);
}

/** Connects with `connectRaw`, completes the TLS handshake, and resolves to a plaintext stream. */
export function connectTls(
  host: string,
  port: number,
  timeoutMs: number,
  connectRaw: Connector,
  newSession: (host: string) => TlsSession
): Promise<ByteStream> {
  let session: TlsSession;
  try {
    session = newSession(host);
  } catch (e) {
    return Promise.reject(tlsError(e));
  }
  const started = Date.now();

  return connectRaw(host, port, timeoutMs).then(
    (raw) =>
      new Promise<ByteStream>((resolve, reject) => {
        let handshaking = true;
        let closed = false;
        const pending: Uint8Array[] = [];
        let onDataHandler: ((data: Uint8Array) => void) | null = null;

        const plain = {
          write(data) {
            if (closed) return true;
            try {
              session.write(data);
              return flush();
            } catch (e) {
              teardown(tlsError(e));
              return true;
            }
          },
          close() {
            if (closed) return;
            try {
              session.closeNotify();
              flush();
            } catch {
              // best effort
            }
            teardown(null);
          },
          get onData() {
            return onDataHandler;
          },
          set onData(fn: ((data: Uint8Array) => void) | null) {
            onDataHandler = fn;
            deliver();
          },
          onClose: null,
          onDrain: null,
        } as ByteStream;

        function deliver() {
          while (!closed && onDataHandler && pending.length) {
            const chunk = pending.shift() as Uint8Array;
            onDataHandler(chunk);
          }
        }

        function flush(): boolean {
          const out = session.takeOutgoing();
          return out.length ? raw.write(out) : true;
        }

        function teardown(err: TransportError | null) {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          raw.onData = null;
          raw.onClose = null;
          raw.onDrain = null;
          raw.close();
          session.free();
          if (handshaking) {
            handshaking = false;
            reject(err || new TransportError('network', `connection to ${host} closed during the secure handshake`));
            return;
          }
          const cb = plain.onClose;
          plain.onClose = null;
          if (cb) cb(err);
        }

        const timer = setTimeout(() => {
          if (handshaking) teardown(new TransportError('timeout', `secure handshake with ${host} timed out`));
        }, Math.max(1000, timeoutMs - (Date.now() - started)));

        raw.onDrain = () => {
          if (plain.onDrain) plain.onDrain();
        };
        raw.onClose = (err) => teardown(err);
        raw.onData = (data) => {
          if (closed) return;
          try {
            session.feed(data);
            flush();
          } catch (e) {
            teardown(tlsError(e));
            return;
          }
          if (handshaking && !session.isHandshaking()) {
            handshaking = false;
            clearTimeout(timer);
            resolve(plain);
          }
          if (!handshaking) {
            const bytes = session.read();
            if (bytes.length) pending.push(bytes);
            const peerClosed = session.peerClosed();
            deliver();
            if (peerClosed) teardown(null);
          }
        };

        try {
          flush();
        } catch (e) {
          teardown(tlsError(e));
        }
      })
  );
}
