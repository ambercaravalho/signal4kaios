/* Contact discovery (CDSI): enclave attestation through the wasm module, and the request and response framing in engine/services/cdsi.ts. The fixtures are libsignal's rust/attest/tests/data/cdsi.* (a real staging enclave attestation). */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { concatBytes } from '../src/engine/bytes';
import { ClientRequestSchema, ClientResponseSchema } from '../src/engine/gen/cds2_pb';
import { create, fromBinary, toBinary } from '../src/engine/net/proto';
import type { SocketLike } from '../src/engine/net/transport';
import { libsignal } from '../src/engine/protocol/libsignal';
import { MemorySignalStore } from '../src/engine/protocol/store';
import { CdsiChannel, CdsiDeps, CdsiError, cdsiLookup, errorForClose, parseTriples, serializeE164s } from '../src/engine/services/cdsi';
import { loadWasmForTests } from './support';

loadWasmForTests();

const fixture = (name: string) => new Uint8Array(readFileSync(join(process.cwd(), 'test/fixtures/cdsi', name)));
const mrenclave = fixture('cdsi.mrenclave');
const attestation = fixture('cdsi.handshakestart');
const attestedAtMs = Number(new DataView(fixture('cdsi.timestamp').buffer).getBigUint64(0)) * 1000;

test('cdsi: a genuine enclave attestation starts the Noise handshake', () => {
  const client = new libsignal.Cds2Client(mrenclave, attestation, attestedAtMs);
  try {
    assert.ok(client.initialRequest().length > 0);
    assert.throws(() => client.establishedSend(new Uint8Array(4)), /not established/);
  } finally {
    client.free();
  }
});

test('cdsi: attestation is rejected when expired, for another enclave, or tampered with', () => {
  const twoYearsMs = 2 * 365 * 24 * 3600 * 1000;
  assert.throws(() => new libsignal.Cds2Client(mrenclave, attestation, attestedAtMs + twoYearsMs), /attestation failed/);
  assert.throws(() => new libsignal.Cds2Client(libsignal.cdsiMrenclave(), attestation, attestedAtMs), /attestation failed/);
  const tampered = attestation.slice();
  tampered[5000] ^= 1;
  assert.throws(() => new libsignal.Cds2Client(mrenclave, tampered, attestedAtMs), /attestation failed/);
});

test('cdsi: the production enclave id matches libsignal-net', () => {
  assert.equal(Buffer.from(libsignal.cdsiMrenclave()).toString('hex'), '15637fa1e54fe655176d3df1a9f94b87c01ed377acaa570682dc5d72c95ef07b');
});

const hex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const ACI_BYTES = hex('0102030405060708a1a2a3a4a5a6a7a8');
const PNI_BYTES = hex('b1b2b3b4b5b6b7b81112131415161718');

test('cdsi: numbers serialize as 8 big-endian bytes (libsignal-net serialize_e164s)', () => {
  const numbers = [0, 1, 2, 3, 4].map((i) => '+' + (18005551001 + i));
  assert.equal(Buffer.from(serializeE164s(numbers)).toString('hex'), '000000043136e799000000043136e79a000000043136e79b000000043136e79c000000043136e79d');
  assert.throws(() => serializeE164s(['5551234']), CdsiError);
  assert.throws(() => serializeE164s(['+0123']), CdsiError);
});

test('cdsi: response triples parse like libsignal-net, nil UUIDs as none', () => {
  const record = concatBytes(serializeE164s(['+18005551001']), PNI_BYTES, ACI_BYTES);
  const parsed = parseTriples(concatBytes(record, record));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { e164: '+18005551001', pni: 'b1b2b3b4-b5b6-b7b8-1112-131415161718', aci: '01020304-0506-0708-a1a2-a3a4a5a6a7a8' });
  const noAci = concatBytes(serializeE164s(['+18005551002']), PNI_BYTES, new Uint8Array(16));
  assert.deepEqual(parseTriples(noAci), [{ e164: '+18005551002', pni: 'b1b2b3b4-b5b6-b7b8-1112-131415161718', aci: null }]);
  assert.deepEqual(parseTriples(new Uint8Array(40)), []);
  assert.throws(() => parseTriples(new Uint8Array(39)), /could not parse/);
});

test('cdsi: close codes map to libsignal-net errors', () => {
  const limited = errorForClose(4008, '{"retry_after": 125}') as CdsiError;
  assert.equal(limited.code, 'CdsiRateLimited');
  assert.equal(limited.retryAfterSeconds, 125);
  assert.equal(limited.status, 429);
  assert.equal((errorForClose(4008, 'not json') as CdsiError).code, 'CdsiProtocolError');
  assert.equal((errorForClose(4003, '') as CdsiError).code, 'CdsiInvalidArgument');
  assert.equal((errorForClose(4101, '') as CdsiError).code, 'CdsiInvalidToken');
  assert.equal((errorForClose(4014, '') as CdsiError).code, 'CdsiServerError');
  assert.equal((errorForClose(4003, 'WebSocket upgrade failed (HTTP 403)') as { status?: number }).status, 403);
  assert.equal((errorForClose(1006, 'WebSocket upgrade failed (HTTP 429)') as CdsiError).code, 'CdsiRateLimited');
  assert.equal((errorForClose(1006, 'connection lost') as { kind?: string }).kind, 'network');
});

class FakeSocket implements SocketLike {
  readyState = 1;
  binaryType = 'arraybuffer';
  sent: Uint8Array[] = [];
  closed = false;
  onopen: ((evt: any) => void) | null = null;
  onmessage: ((evt: { data: any }) => void) | null = null;
  onerror: ((evt: any) => void) | null = null;
  onclose: ((evt: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  constructor(readonly url: string, readonly headers: Record<string, string>) {}
  send(data: ArrayBuffer | ArrayBufferView | string): void {
    this.sent.push(new Uint8Array((data as Uint8Array).slice()));
  }
  close(): void {
    this.closed = true;
  }
  serve(bytes: Uint8Array): void {
    this.onmessage!({ data: bytes.slice().buffer });
  }
  end(code: number, reason = ''): void {
    this.onclose!({ code, reason, wasClean: true });
  }
}

/** Plaintext in place of the Noise channel, so the framing around it can be checked. */
const passThrough = (attestation: Uint8Array): CdsiChannel => {
  if (attestation[0] !== 0xaa) throw new Error('attestation failed: bad quote');
  return { initialRequest: () => hex('c0ffee'), completeHandshake() {}, establishedSend: (p) => p, establishedRecv: (c) => c, free() {} };
};

function lookupHarness(e164s: string[]) {
  const store = new MemorySignalStore({ aci: 'aci-me', number: '+15550000', deviceId: 2, password: 'pw', registrationId: 1, pniRegistrationId: 2, aciIdentityKeyPair: { pubKey: new Uint8Array(33), privKey: new Uint8Array(32) } });
  const calls: Array<{ path: string; auth: unknown }> = [];
  let sock: FakeSocket | null = null;
  const deps: CdsiDeps = {
    httpJson: async (_method, path, _body, opts) => {
      calls.push({ path, auth: opts && opts.basicAuth });
      return { username: 'dir-user', password: 'dir-pass' };
    },
    openWebSocket: (url, opts) => (sock = new FakeSocket(url, opts.headers || {})),
    newChannel: passThrough,
  };
  const result = cdsiLookup(store, deps, e164s);
  const socket = async () => {
    for (let i = 0; i < 20 && !sock; i++) await new Promise((r) => setImmediate(r));
    return sock!;
  };
  return { result, calls, socket };
}

const response = (init: { token?: Uint8Array; e164PniAciTriples?: Uint8Array }) => toBinary(ClientResponseSchema, create(ClientResponseSchema, init));

test('cdsi: a lookup attests first, then sends the numbers, acknowledges the token, and collects the records', async () => {
  const h = lookupHarness(['+18005551001']);
  const sock = await h.socket();
  assert.deepEqual(h.calls, [{ path: '/v2/directory/auth', auth: { username: 'aci-me.2', password: 'pw' } }]);
  assert.equal(sock.url, `wss://cdsi.signal.org/v1/${Buffer.from(libsignal.cdsiMrenclave()).toString('hex')}/discovery`);
  assert.equal(sock.headers.Authorization, 'Basic ' + Buffer.from('dir-user:dir-pass').toString('base64'));

  sock.serve(hex('aa01'));
  assert.deepEqual(sock.sent, [hex('c0ffee')]);
  sock.serve(hex('bb'));
  const req = fromBinary(ClientRequestSchema, sock.sent[1]);
  assert.equal(Buffer.from(req.newE164s).toString('hex'), '000000043136e799');
  assert.equal(req.token.length, 0);
  assert.equal(req.tokenAck, false);

  sock.serve(response({ token: hex('70') }));
  assert.equal(fromBinary(ClientRequestSchema, sock.sent[2]).tokenAck, true);
  sock.serve(response({ e164PniAciTriples: concatBytes(serializeE164s(['+18005551001']), PNI_BYTES, ACI_BYTES) }));
  sock.end(1000);
  assert.deepEqual(await h.result, [{ e164: '+18005551001', pni: 'b1b2b3b4-b5b6-b7b8-1112-131415161718', aci: '01020304-0506-0708-a1a2-a3a4a5a6a7a8' }]);
  assert.ok(sock.closed);
});

test('cdsi: no number leaves the phone when attestation fails', async () => {
  const h = lookupHarness(['+18005551001']);
  const sock = await h.socket();
  sock.serve(hex('00'));
  await assert.rejects(h.result, (e: CdsiError) => e.code === 'CdsiAttestationFailed');
  assert.equal(sock.sent.length, 0);
  assert.ok(sock.closed);
});

test('cdsi: a rate-limit close reports when to retry', async () => {
  const h = lookupHarness(['+18005551001']);
  const sock = await h.socket();
  sock.serve(hex('aa'));
  sock.serve(hex('bb'));
  sock.end(4008, '{"retry_after":90}');
  await assert.rejects(h.result, (e: CdsiError) => e.code === 'CdsiRateLimited' && e.retryAfterSeconds === 90);
});

test('cdsi: a response without a token, or a text frame, is a protocol error', async () => {
  const a = lookupHarness(['+18005551001']);
  const sockA = await a.socket();
  sockA.serve(hex('aa'));
  sockA.serve(hex('bb'));
  sockA.serve(response({}));
  await assert.rejects(a.result, /no token/);

  const b = lookupHarness(['+18005551001']);
  const sockB = await b.socket();
  sockB.onmessage!({ data: 'hello' });
  await assert.rejects(b.result, /unexpected text/);
});
