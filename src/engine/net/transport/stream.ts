/** Byte-stream plumbing shared by the TCP, TLS, HTTP/1.1, and WebSocket layers. */

export type TransportErrorKind = 'network' | 'timeout' | 'tls' | 'protocol';

export class TransportError extends Error {
  readonly kind: TransportErrorKind;

  constructor(kind: TransportErrorKind, message: string) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
  }
}

/** A connected, ordered byte stream. `write` returns false once the outgoing buffer is full; `onDrain` fires when it empties. */
export interface ByteStream {
  write(data: Uint8Array): boolean;
  close(): void;
  onData: ((data: Uint8Array) => void) | null;
  /** Fires once. `err` is null for an orderly end of stream. */
  onClose: ((err: TransportError | null) => void) | null;
  onDrain: (() => void) | null;
}

export type Connector = (host: string, port: number, timeoutMs: number) => Promise<ByteStream>;

/** Writes `data` in slices, waiting for `onDrain` whenever the stream reports a full buffer. */
export function writeAll(stream: ByteStream, data: Uint8Array, chunkSize = 64 * 1024): Promise<void> {
  return new Promise((resolve) => {
    let offset = 0;
    const pump = () => {
      while (offset < data.length) {
        const end = Math.min(offset + chunkSize, data.length);
        const ok = stream.write(data.subarray(offset, end));
        offset = end;
        if (!ok && offset < data.length) {
          stream.onDrain = () => {
            stream.onDrain = null;
            pump();
          };
          return;
        }
      }
      resolve();
    };
    pump();
  });
}
