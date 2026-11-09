/* Helpers over the generated protobuf-es codecs in ./gen (from the vendored Signal-Desktop and libsignal .proto files; regenerate with npm run gen:protos). */

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import { bytesToUuid } from './bytes';
import {
  WebSocketMessage,
  WebSocketMessage_Type,
  WebSocketMessageSchema,
} from './gen/chat_websocket_pb';

export { create, fromBinary, toBinary };

export function decodeWebSocketMessage(bytes: Uint8Array): WebSocketMessage {
  return fromBinary(WebSocketMessageSchema, bytes);
}

export function encodeWebSocketResponse(id: bigint, status: number, message: string): Uint8Array {
  return toBinary(
    WebSocketMessageSchema,
    create(WebSocketMessageSchema, {
      type: WebSocketMessage_Type.RESPONSE,
      response: { id, status, message },
    })
  );
}

export function encodeWebSocketRequest(verb: string, path: string, id: bigint, body?: Uint8Array): Uint8Array {
  return toBinary(
    WebSocketMessageSchema,
    create(WebSocketMessageSchema, {
      type: WebSocketMessage_Type.REQUEST,
      request: { verb, path, id, body },
    })
  );
}

/** Service ID string from the string field or its binary twin (16-byte ACI, or 17 bytes with a 0x01 PNI prefix), as Signal-Desktop's fromServiceIdBinaryOrString does. */
export function serviceIdFrom(str: string | undefined, binary: Uint8Array | undefined): string {
  if (str) return str;
  if (!binary || binary.length === 0) return '';
  if (binary.length === 16) return bytesToUuid(binary);
  if (binary.length === 17 && binary[0] === 0x00) return bytesToUuid(binary.subarray(1));
  if (binary.length === 17 && binary[0] === 0x01) return 'PNI:' + bytesToUuid(binary.subarray(1));
  return '';
}

/** Reads a stream of varint32 length-prefixed records (contact sync blobs). Yields each record's bytes and the offset just past it. */
export function* readDelimited(buf: Uint8Array): Generator<{ bytes: Uint8Array; end: number; skip: (n: number) => void }> {
  let pos = 0;
  while (pos < buf.length) {
    let len = 0;
    let shift = 0;
    let b: number;
    do {
      if (pos >= buf.length || shift > 28) return;
      b = buf[pos++];
      len |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    len >>>= 0;
    if (len === 0 || pos + len > buf.length) return;
    const bytes = buf.subarray(pos, pos + len);
    pos += len;
    yield {
      bytes,
      end: pos,
      skip: (n: number) => {
        pos = Math.min(buf.length, pos + n);
      },
    };
  }
}

/** bigint timestamps (uint64 in the protos) as JS numbers; Signal timestamps are milliseconds and fit in 2^53. */
export function num(v: bigint | number | undefined): number {
  if (v === undefined) return 0;
  return typeof v === 'bigint' ? Number(v) : v;
}
