/* Phone number lookup through Signal's contact discovery service (CDSI), ported from libsignal-net (rust/net/src/cdsi.rs and infra/src/ws/attested.rs): directory credentials from the chat server, an SGX-attested Noise channel to the enclave (libsignal's attest crate, via the wasm module), then one request for the numbers, a token acknowledgement, and the e164/PNI/ACI records. Every frame from the server is untrusted. */

import { mergeFromBinary } from '@bufbuild/protobuf';

import { bytesToUuid, toBase64, toHex } from '../bytes';
import { ClientRequestSchema, ClientResponseSchema, type ClientResponse } from '../gen/cds2_pb';
import { accountBasicAuth, asObject, DEFAULT_SIGNAL_SERVER, SignalHttpJsonFn } from '../net/http';
import { create, toBinary } from '../net/proto';
import type { SocketLike } from '../net/transport';
import { libsignal } from '../protocol/libsignal';
import type { SignalProtocolStore } from '../protocol/store';

export const CDSI_URL = 'wss://cdsi.signal.org';
const LOOKUP_TIMEOUT_MS = 30000;
const E164_LEN = 8;
const UUID_LEN = 16;
const RECORD_LEN = E164_LEN + 2 * UUID_LEN;
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

/** Close codes the enclave sets, as libsignal-net's `CdsiCloseCode`. */
const CLOSE_INVALID_ARGUMENT = 4003;
const CLOSE_RATE_LIMITED = 4008;
const CLOSE_SERVER_ERROR = 4013;
const CLOSE_SERVER_UNAVAILABLE = 4014;
const CLOSE_INVALID_TOKEN = 4101;

type CdsiErrorCode = 'CdsiRateLimited' | 'CdsiInvalidArgument' | 'CdsiServerError' | 'CdsiInvalidToken' | 'CdsiProtocolError' | 'CdsiAttestationFailed';

export class CdsiError extends Error {
  readonly code: CdsiErrorCode;
  /** Seconds the server asked us to wait, for `CdsiRateLimited`. */
  readonly retryAfterSeconds?: number;
  /** 429 for rate limits, so generic error wording treats it like any other. */
  readonly status?: number;

  constructor(code: CdsiErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = code;
    this.code = code;
    if (code === 'CdsiRateLimited') {
      this.retryAfterSeconds = retryAfterSeconds;
      this.status = 429;
    }
  }
}

export interface CdsiRecord {
  e164: string;
  aci: string | null;
  pni: string | null;
}

/** The attested Noise channel; `libsignal.Cds2Client` in the app, a stand-in in tests. */
export interface CdsiChannel {
  initialRequest(): Uint8Array;
  completeHandshake(reply: Uint8Array): void;
  establishedSend(plaintext: Uint8Array): Uint8Array;
  establishedRecv(ciphertext: Uint8Array): Uint8Array;
  free(): void;
}

export interface CdsiDeps {
  httpJson: SignalHttpJsonFn;
  openWebSocket(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> }): SocketLike;
  serverUrl?: string;
  cdsiUrl?: string;
  /** Verifies the enclave's attestation message and starts the handshake; throws when attestation fails. */
  newChannel?(attestation: Uint8Array): CdsiChannel;
}

function attestedChannel(attestation: Uint8Array): CdsiChannel {
  return new libsignal.Cds2Client(libsignal.cdsiMrenclave(), attestation, Date.now());
}

/** Each number as 8 big-endian bytes, as libsignal's `FixedLengthSerializable for E164`. */
export function serializeE164s(e164s: string[]): Uint8Array {
  const out = new Uint8Array(e164s.length * E164_LEN);
  const view = new DataView(out.buffer);
  e164s.forEach((e164, i) => {
    if (!E164_PATTERN.test(e164)) throw new CdsiError('CdsiInvalidArgument', 'Not a phone number in E.164 form');
    view.setBigUint64(i * E164_LEN, BigInt(e164.slice(1)));
  });
  return out;
}

function nonNilUuid(bytes: Uint8Array): string | null {
  return bytes.some((b) => b !== 0) ? bytesToUuid(bytes) : null;
}

/** The 40-byte e164/PNI/ACI records of a response, as libsignal's `LookupResponse::try_from`: a nil UUID means none, and a zero number is skipped. */
export function parseTriples(bytes: Uint8Array): CdsiRecord[] {
  if (bytes.length % RECORD_LEN !== 0) throw new CdsiError('CdsiProtocolError', `could not parse response triples (${bytes.length} bytes)`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records: CdsiRecord[] = [];
  for (let off = 0; off < bytes.length; off += RECORD_LEN) {
    const number = view.getBigUint64(off);
    if (number === BigInt(0)) continue;
    records.push({
      e164: '+' + number.toString(),
      pni: nonNilUuid(bytes.subarray(off + E164_LEN, off + E164_LEN + UUID_LEN)),
      aci: nonNilUuid(bytes.subarray(off + E164_LEN + UUID_LEN, off + RECORD_LEN)),
    });
  }
  return records;
}

/** The error for a close before the lookup finished, as libsignal-net's `err_for_close`. */
export function errorForClose(code: number, reason: string): Error {
  // A refused upgrade arrives as a local close whose code can collide with the enclave's (HTTP 403 becomes 4003).
  const upgrade = /^WebSocket upgrade failed \(HTTP (\d{3})\)/.exec(reason);
  if (upgrade) {
    const status = Number(upgrade[1]);
    if (status === 429) return new CdsiError('CdsiRateLimited', 'rate limited');
    return Object.assign(new Error(`CDSI connection refused (HTTP ${status})`), { status });
  }
  switch (code) {
    case CLOSE_RATE_LIMITED: {
      let retryAfter: unknown;
      try {
        retryAfter = (asObject(JSON.parse(reason)) || {}).retry_after;
      } catch {
        retryAfter = undefined;
      }
      if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
        return new CdsiError('CdsiRateLimited', `rate limited; retry after ${Math.ceil(retryAfter)}s`, Math.ceil(retryAfter));
      }
      return new CdsiError('CdsiProtocolError', 'unexpected close (4008)');
    }
    case CLOSE_INVALID_ARGUMENT:
      return new CdsiError('CdsiInvalidArgument', 'request was invalid');
    case CLOSE_INVALID_TOKEN:
      return new CdsiError('CdsiInvalidToken', 'request token was invalid');
    case CLOSE_SERVER_ERROR:
    case CLOSE_SERVER_UNAVAILABLE:
      return new CdsiError('CdsiServerError', `server error (${code})`);
    default:
      return Object.assign(new Error(`CDSI connection closed (${code})`), { kind: 'network' });
  }
}

/** Basic-auth credentials for the enclave from `GET /v2/directory/auth`. */
async function directoryAuth(store: SignalProtocolStore, httpJson: SignalHttpJsonFn, serverUrl: string): Promise<string> {
  const acc = await store.getAccount();
  if (!acc) throw new Error('Not linked');
  // SECURITY-REVIEW: device credentials fetch the directory credentials, which go only into the Authorization header of the pinned CDSI socket; never log either.
  const res = asObject(await httpJson('GET', '/v2/directory/auth', null, { baseUrl: serverUrl, basicAuth: accountBasicAuth(acc), timeout: 15000 }));
  const username = res && typeof res.username === 'string' ? res.username : '';
  const password = res && typeof res.password === 'string' ? res.password : '';
  if (!username || !password) throw new CdsiError('CdsiProtocolError', 'server returned no directory credentials');
  return 'Basic ' + toBase64(new TextEncoder().encode(`${username}:${password}`));
}

/** Who these numbers belong to on Signal. Numbers without an account, or whose owner hides them from discovery, are left out. */
export async function cdsiLookup(store: SignalProtocolStore, deps: CdsiDeps, e164s: string[]): Promise<CdsiRecord[]> {
  const request = toBinary(ClientRequestSchema, create(ClientRequestSchema, { newE164s: serializeE164s(e164s) }));
  const authorization = await directoryAuth(store, deps.httpJson, deps.serverUrl || DEFAULT_SIGNAL_SERVER);
  const url = `${deps.cdsiUrl || CDSI_URL}/v1/${toHex(libsignal.cdsiMrenclave())}/discovery`;
  const newChannel = deps.newChannel || attestedChannel;

  return new Promise<CdsiRecord[]>((resolve, reject) => {
    let step: 'attestation' | 'handshake' | 'token' | 'results' = 'attestation';
    let channel: CdsiChannel | null = null;
    let response: ClientResponse | null = null;
    let settled = false;
    let sock: SocketLike;

    const settle = (err: Error | null, records?: CdsiRecord[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.onmessage = null;
      sock.onclose = null;
      sock.onerror = null;
      try {
        sock.close();
      } catch {
        // already closed
      }
      if (channel) channel.free();
      channel = null;
      if (err) reject(err);
      else resolve(records || []);
    };

    const sendEncrypted = (plaintext: Uint8Array) => sock.send(channel!.establishedSend(plaintext));

    try {
      sock = deps.openWebSocket(url, { timeoutMs: 15000, headers: { Authorization: authorization } });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => settle(Object.assign(new Error('CDSI lookup timed out'), { kind: 'timeout' })), LOOKUP_TIMEOUT_MS);
    sock.binaryType = 'arraybuffer';

    sock.onmessage = (evt) => {
      if (settled) return;
      try {
        if (!(evt.data instanceof ArrayBuffer)) throw new CdsiError('CdsiProtocolError', 'unexpected text message');
        const frame = new Uint8Array(evt.data);
        switch (step) {
          case 'attestation':
            try {
              channel = newChannel(frame);
            } catch (e) {
              throw new CdsiError('CdsiAttestationFailed', (e as Error).message || 'attestation failed');
            }
            sock.send(channel.initialRequest());
            step = 'handshake';
            return;
          case 'handshake':
            channel!.completeHandshake(frame);
            sendEncrypted(request);
            step = 'token';
            return;
          case 'token': {
            const tokenResponse = mergeFromBinary(ClientResponseSchema, create(ClientResponseSchema), channel!.establishedRecv(frame));
            if (!tokenResponse.token.length) throw new CdsiError('CdsiProtocolError', 'no token found in response');
            sendEncrypted(toBinary(ClientRequestSchema, create(ClientRequestSchema, { tokenAck: true })));
            step = 'results';
            return;
          }
          case 'results':
            response = mergeFromBinary(ClientResponseSchema, response || create(ClientResponseSchema), channel!.establishedRecv(frame));
            return;
        }
      } catch (e) {
        settle(e instanceof Error ? e : new Error(String(e)));
      }
    };

    sock.onclose = (evt) => {
      if (settled) return;
      const normal = evt.code === 1000 || evt.code === 1005;
      if (step === 'results' && response && normal) {
        try {
          settle(null, parseTriples(response.e164PniAciTriples));
        } catch (e) {
          settle(e as Error);
        }
        return;
      }
      settle(errorForClose(evt.code, evt.reason || ''));
    };
  });
}
