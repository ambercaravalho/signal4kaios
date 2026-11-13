/* 1:1 calls: RingRTC's SRTP key agreement and SRTP AEAD_AES_256_GCM in the wasm module, checked against an independent Node implementation, Opus, STUN, TURN, ICE, the jitter buffer, and the call manager's state machine. */

import { strict as assert } from 'node:assert';
import { createCipheriv, createDecipheriv, createHash, diffieHellman, generateKeyPairSync, hkdfSync, KeyObject, createPublicKey } from 'node:crypto';
import { test } from 'node:test';

import { IceAgent, parseCandidate, RelayMux } from '../src/engine/calling/ice';
import { CallManager, MAX_OFFER_AGE_MS, RING_TIMEOUT_MS, type CallDeps, type CallRecord } from '../src/engine/calling/manager';
import { CallAudio, COMPLEXITY_STEPS, OPUS_COMPLEXITY } from '../src/engine/calling/media';
import { JitterBuffer } from '../src/engine/calling/rtp';
import {
  attr,
  crc32,
  decodeStun,
  encodeStun,
  errorCode,
  longTermKey,
  readXorAddress,
  type SocketAddress,
  StunAttr,
  StunType,
  textAttr,
  u32Attr,
  verifyIntegrity,
  xorAddressAttr,
} from '../src/engine/calling/stun';
import { StreamFramer, TurnClient } from '../src/engine/calling/turn';
import { uuidToBytes } from '../src/engine/bytes';
import {
  CallMessage_Hangup_Type,
  CallMessage_HangupSchema,
  CallMessage_Offer_Type,
  CallMessage_OfferSchema,
  CallMessageSchema,
  ContentSchema,
  SyncMessage_CallEvent_Direction,
  SyncMessage_CallEvent_Event,
  SyncMessage_CallEvent_Type,
  SyncMessage_CallLogEvent_Type,
  type CallMessage,
} from '../src/engine/gen/SignalService_pb';
import { ConnectionParametersV4Schema, OfferSchema } from '../src/engine/gen/signaling_pb';
import { contentToNormalizedFrame } from '../src/engine/net/incoming-json';
import { create, toBinary } from '../src/engine/net/proto';
import type { ByteStream } from '../src/engine/net/transport/stream';
import { libsignal } from '../src/engine/protocol/libsignal';
import { loadWasmForTests } from './support';

loadWasmForTests();

const hex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));

/** The SRTP AES-CM PRF (RFC 3711 section 4.3.3, RFC 6188) with a zero key derivation rate. */
function nodeKdf(masterKey: Uint8Array, masterSalt: Uint8Array, label: number, length: number): Uint8Array {
  const iv = new Uint8Array(16);
  iv.set(masterSalt.subarray(0, 14));
  iv[7] ^= label;
  const out = new Uint8Array(Math.ceil(length / 16) * 16);
  const cipher = createCipheriv('aes-256-ecb', masterKey, null).setAutoPadding(false);
  for (let i = 0; i < out.length / 16; i++) {
    const block = iv.slice();
    block[14] = i >> 8;
    block[15] = i & 0xff;
    out.set(cipher.update(block), i * 16);
  }
  return out.subarray(0, length);
}

function gcmIv(salt: Uint8Array, ssrc: number, roc: number, seq: number): Uint8Array {
  const iv = new Uint8Array(12);
  const v = new DataView(iv.buffer);
  v.setUint32(2, ssrc);
  v.setUint32(6, roc);
  v.setUint16(10, seq);
  for (let i = 0; i < 12; i++) iv[i] ^= salt[i];
  return iv;
}

function rtp(seq: number, ssrc: number, payload: Uint8Array, pt = 102): Uint8Array {
  const p = new Uint8Array(12 + payload.length);
  const v = new DataView(p.buffer);
  p[0] = 0x80;
  p[1] = pt;
  v.setUint16(2, seq);
  v.setUint32(4, seq * 2880);
  v.setUint32(8, ssrc);
  p.set(payload, 12);
  return p;
}

function nodeProtect(master: Uint8Array, packet: Uint8Array, roc = 0): Uint8Array {
  const key = nodeKdf(master.subarray(0, 32), master.subarray(32), 0, 32);
  const salt = nodeKdf(master.subarray(0, 32), master.subarray(32), 2, 12);
  const v = new DataView(packet.buffer, packet.byteOffset);
  const c = createCipheriv('aes-256-gcm', key, gcmIv(salt, v.getUint32(8), roc, v.getUint16(2)));
  c.setAAD(packet.subarray(0, 12));
  const body = Buffer.concat([c.update(packet.subarray(12)), c.final()]);
  return new Uint8Array(Buffer.concat([packet.subarray(0, 12), body, c.getAuthTag()]));
}

function nodeUnprotect(master: Uint8Array, packet: Uint8Array): Uint8Array {
  const key = nodeKdf(master.subarray(0, 32), master.subarray(32), 0, 32);
  const salt = nodeKdf(master.subarray(0, 32), master.subarray(32), 2, 12);
  const v = new DataView(packet.buffer, packet.byteOffset);
  const d = createDecipheriv('aes-256-gcm', key, gcmIv(salt, v.getUint32(8), 0, v.getUint16(2)));
  d.setAAD(packet.subarray(0, 12));
  d.setAuthTag(packet.subarray(packet.length - 16));
  return new Uint8Array(Buffer.concat([packet.subarray(0, 12), d.update(packet.subarray(12, packet.length - 16)), d.final()]));
}

function rawX25519Public(k: KeyObject): Uint8Array {
  return new Uint8Array(Buffer.from(k.export({ format: 'jwk' }).x as string, 'base64url'));
}

function x25519PublicFromRaw(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' });
}

test('calling: the Node SRTP key derivation matches the RFC 6188 AES-256 vectors', () => {
  const masterKey = hex('f0f04914b513f2763a1b1fa130f10e2998f6f6e43e4309d1e622a0e332b9f1b6');
  const masterSalt = hex('3b04803de51ee7c96423ab5b78d2');
  assert.equal(Buffer.from(nodeKdf(masterKey, masterSalt, 0, 32)).toString('hex'), '5ba1064e30ec51613cad926c5a28ef731ec7fb397f70a960653caf06554cd8c4');
  assert.equal(Buffer.from(nodeKdf(masterKey, masterSalt, 2, 14)).toString('hex'), 'fa31791685ca444a9e07c6c64e93');
});

test('calling: SRTP keys follow RingRTC: HKDF over X25519 with the caller and callee identity keys; the caller sends with the offer key', () => {
  const callerIdentity = crypto.getRandomValues(new Uint8Array(32));
  const calleeIdentity = crypto.getRandomValues(new Uint8Array(32));
  const peer = generateKeyPairSync('x25519');
  const ours = new libsignal.CallKeyPair();
  const pair = ours.srtp(rawX25519Public(peer.publicKey), callerIdentity, calleeIdentity, true);

  const shared = diffieHellman({ privateKey: peer.privateKey, publicKey: x25519PublicFromRaw(ours.publicKey()) });
  const info = Buffer.concat([Buffer.from('Signal_Calling_20200807_SignallingDH_SRTPKey_KDF'), callerIdentity, calleeIdentity]);
  const okm = new Uint8Array(hkdfSync('sha256', shared, new Uint8Array(32), info, 88));
  const offerMaster = okm.subarray(0, 44);
  const answerMaster = okm.subarray(44, 88);

  const payload = new TextEncoder().encode('opus frame');
  const sent = pair.protectRtp(rtp(7, 1002, payload));
  assert.deepEqual(nodeUnprotect(offerMaster, sent).subarray(12), payload);

  const fromPeer = nodeProtect(answerMaster, rtp(9, 2002, payload));
  assert.deepEqual(pair.unprotectRtp(fromPeer).subarray(12), payload);
  assert.throws(() => pair.unprotectRtp(fromPeer), /replayed/);

  const forged = fromPeer.slice();
  forged[14] ^= 1;
  assert.throws(() => pair.unprotectRtp(nodeProtect(offerMaster, rtp(10, 2002, payload))), /authentication/);
  assert.throws(() => pair.unprotectRtp(forged), /authentication|replayed/);
  pair.free();
  ours.free();
});

test('calling: both ends of a call agree, and sequence numbers roll over', () => {
  const a = new libsignal.CallKeyPair();
  const b = new libsignal.CallKeyPair();
  const idA = crypto.getRandomValues(new Uint8Array(32));
  const idB = crypto.getRandomValues(new Uint8Array(32));
  const caller = a.srtp(b.publicKey(), idA, idB, true);
  const callee = b.srtp(a.publicKey(), idA, idB, false);
  for (const seq of [65533, 65534, 65535, 0, 1, 2]) {
    const p = rtp(seq, 1002, new Uint8Array([seq & 0xff]));
    assert.deepEqual(callee.unprotectRtp(caller.protectRtp(p)), p);
  }
  const back = rtp(3, 2002, new Uint8Array([1, 2, 3]));
  assert.deepEqual(caller.unprotectRtp(callee.protectRtp(back)), back);
  assert.throws(() => new libsignal.CallKeyPair().srtp(new Uint8Array(32), idA, idB, true), /non-contributory/);
});

test('calling: Opus encodes and decodes 60 ms voice frames and conceals a lost one', () => {
  const rate = 16000;
  const frame = (rate * 60) / 1000;
  const enc = new libsignal.OpusEncoder(rate, 24000, 3);
  const dec = new libsignal.OpusDecoder(rate);
  const pcm = new Float32Array(frame);
  for (let i = 0; i < frame; i++) pcm[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate);
  const packet = enc.encode(pcm);
  assert.ok(packet.length > 10 && packet.length < 400, `packet of ${packet.length} bytes`);
  assert.equal(dec.decode(packet, frame, false).length, frame);
  assert.equal(dec.decode(new Uint8Array(0), frame, false).length, frame);
  enc.free();
  dec.free();
});

/** RFC 5769 section 2.1: a Binding request with a short-term credential and a fingerprint. */
const RFC5769_REQUEST = hex(
  '000100582112a442b7e7a701bc34d686fa87dfae802200105354554e207465737420636c69656e74002400046e0001ff80290008932ff9b151263b36000600096576746a3a68367659202020000800149aeaa70cbfd8cb56781ef2b5b2d3f249c1b571a280280004e57a3bcf'
);

test('calling: STUN checks the integrity and fingerprint of the RFC 5769 sample request', () => {
  assert.ok(verifyIntegrity(RFC5769_REQUEST, new TextEncoder().encode('VOkJxbRl1RmTxUk/WvJxBt')));
  assert.ok(!verifyIntegrity(RFC5769_REQUEST, new TextEncoder().encode('VOkJxbRl1RmTxUk/WvJxBu')));
  assert.equal((crc32(RFC5769_REQUEST.subarray(0, RFC5769_REQUEST.length - 8)) ^ 0x5354554e) >>> 0, 0xe57a3bcf);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const msg = decodeStun(RFC5769_REQUEST)!;
  assert.equal(msg.type, StunType.BindingRequest);
  assert.equal(new TextDecoder().decode(attr(msg, StunAttr.Username)), 'evtj:h6vY');
});

test('calling: STUN messages round-trip XOR addresses under integrity, and tampering breaks it', () => {
  const tid = new Uint8Array(12).fill(7);
  const key = longTermKey('user', 'realm', 'pass');
  assert.deepEqual(key, new Uint8Array(createHash('md5').update('user:realm:pass').digest()));
  for (const addr of [
    { ip: '192.0.2.1', port: 32853 },
    { ip: '2001:db8:1234:5678:11:2233:4455:6677', port: 32853 },
  ]) {
    const bytes = encodeStun({ type: StunType.AllocateSuccess, transactionId: tid, attrs: [xorAddressAttr(StunAttr.XorRelayedAddress, addr, tid), u32Attr(StunAttr.Lifetime, 600)] }, key, true);
    assert.ok(verifyIntegrity(bytes, key));
    const msg = decodeStun(bytes)!;
    assert.deepEqual(readXorAddress(attr(msg, StunAttr.XorRelayedAddress), msg.transactionId), addr);
    const tampered = bytes.slice();
    tampered[26] ^= 1;
    assert.ok(!verifyIntegrity(tampered, key));
  }
  assert.equal(decodeStun(new Uint8Array(19)), null);
  assert.equal(decodeStun(new Uint8Array([0x80, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42, ...new Uint8Array(12)])), null);
});

function fakeStream(onWrite: (data: Uint8Array) => void): ByteStream {
  return {
    write(d) {
      onWrite(d);
      return true;
    },
    close() {},
    onData: null,
    onClose: null,
    onDrain: null,
  };
}

test('calling: TURN allocates after the 401 challenge, binds a channel, and frames data both ways over the stream', async () => {
  const realm = 'signal';
  const key = longTermKey('u', realm, 'p');
  const relayed = { ip: '203.0.113.5', port: 50000 };
  const mapped = { ip: '198.51.100.7', port: 1234 };
  const peer = { ip: '192.0.2.9', port: 3478 };
  const log: string[] = [];
  let channel = 0;
  const stream = fakeStream((d) => {
    if ((d[0] & 0xc0) === 0x40) {
      log.push(`channel ${(d[0] << 8) | d[1]} ${(d[2] << 8) | d[3]} padded ${d.length}`);
      return;
    }
    const msg = decodeStun(d)!;
    const tid = msg.transactionId;
    const reply = (type: number, attrs: Parameters<typeof encodeStun>[0]['attrs'], signed = true) => {
      const r = encodeStun({ type, transactionId: tid, attrs }, signed ? key : undefined);
      stream.onData!(r.subarray(0, 7));
      stream.onData!(r.subarray(7));
    };
    if (msg.type === StunType.AllocateRequest && !attr(msg, StunAttr.MessageIntegrity)) {
      log.push('challenge');
      return reply(StunType.AllocateError, [{ type: StunAttr.ErrorCode, value: new Uint8Array([0, 0, 4, 1]) }, textAttr(StunAttr.Realm, realm), textAttr(StunAttr.Nonce, 'n1')], false);
    }
    assert.ok(verifyIntegrity(d, key), 'signed with the long-term key');
    if (msg.type === StunType.AllocateRequest) return reply(StunType.AllocateSuccess, [xorAddressAttr(StunAttr.XorRelayedAddress, relayed, tid), xorAddressAttr(StunAttr.XorMappedAddress, mapped, tid), u32Attr(StunAttr.Lifetime, 600)]);
    if (msg.type === StunType.CreatePermissionRequest) {
      log.push('permit ' + readXorAddress(attr(msg, StunAttr.XorPeerAddress), tid)!.ip);
      return reply(StunType.CreatePermissionSuccess, []);
    }
    if (msg.type === StunType.ChannelBindRequest) {
      const n = attr(msg, StunAttr.ChannelNumber)!;
      channel = (n[0] << 8) | n[1];
      return reply(StunType.ChannelBindSuccess, []);
    }
    if (msg.type === StunType.RefreshRequest) log.push('refresh');
  });

  const turn = new TurnClient(stream, { username: 'u', password: 'p' });
  const alloc = await turn.allocate();
  assert.deepEqual(alloc.relayed, relayed);
  assert.deepEqual(alloc.mapped, mapped);
  await turn.permit(peer);
  assert.ok(channel >= 0x4000 && channel <= 0x4ffe);
  assert.ok(turn.send(peer, new Uint8Array([1, 2, 3, 4, 5])));
  assert.deepEqual(log, ['challenge', 'permit 192.0.2.9', `channel ${channel} 5 padded 12`]);

  const got: Array<[SocketAddress, number[]]> = [];
  turn.onPeerData = (from, data) => got.push([from, Array.from(data)]);
  const frame = new Uint8Array([channel >> 8, channel & 0xff, 0, 3, 9, 8, 7, 0]);
  stream.onData!(frame.subarray(0, 2));
  stream.onData!(frame.subarray(2));
  const tid = new Uint8Array(12).fill(3);
  stream.onData!(encodeStun({ type: StunType.DataIndication, transactionId: tid, attrs: [xorAddressAttr(StunAttr.XorPeerAddress, { ip: '192.0.2.10', port: 9 }, tid), { type: StunAttr.Data, value: new Uint8Array([6]) }] }));
  assert.deepEqual(got, [
    [peer, [9, 8, 7]],
    [{ ip: '192.0.2.10', port: 9 }, [6]],
  ]);
  turn.close();
  assert.equal(log[log.length - 1], 'refresh');
});

test('calling: the TURN stream framer rejects frames that are neither STUN nor ChannelData', () => {
  const frames: number[] = [];
  const errors: string[] = [];
  const framer = new StreamFramer(
    (f) => frames.push(f.length),
    (e) => errors.push(e.message)
  );
  framer.push(new Uint8Array([0x40, 0x00, 0x00, 0x01, 0xaa, 0, 0, 0, 0x80, 0, 0, 0]));
  assert.deepEqual(frames, [5]);
  assert.deepEqual(errors, ['relay sent an unknown frame']);
});

function fakeTurn(relayed: SocketAddress) {
  return {
    relayed,
    onPeerData: null as ((from: SocketAddress, data: Uint8Array) => void) | null,
    deliver: null as ((from: SocketAddress, data: Uint8Array) => void) | null,
    permits: [] as string[],
    permit(p: SocketAddress) {
      this.permits.push(p.ip);
      return Promise.resolve();
    },
    send(_peer: SocketAddress, data: Uint8Array) {
      const d = data.slice();
      setImmediate(() => this.deliver && this.deliver(relayed, d));
      return true;
    },
  };
}

test('calling: two relay-only ICE agents connect through their relays and then carry media', async () => {
  const addrA = { ip: '203.0.113.1', port: 1000 };
  const addrB = { ip: '203.0.113.2', port: 2000 };
  const ta = fakeTurn(addrA);
  const tb = fakeTurn(addrB);
  const a = new IceAgent({ turn: ta as never, controlling: true, localUfrag: 'aaaa', localPwd: 'a'.repeat(22) });
  const b = new IceAgent({ turn: tb as never, controlling: false, localUfrag: 'bbbb', localPwd: 'b'.repeat(22) });
  ta.deliver = (from, d) => b.receive(from, d);
  tb.deliver = (from, d) => a.receive(from, d);
  a.setRemoteCredentials('bbbb', 'b'.repeat(22));
  b.setRemoteCredentials('aaaa', 'a'.repeat(22));
  a.addRemoteCandidate(parseCandidate(`candidate:1 1 udp 16777215 ${addrB.ip} ${addrB.port} typ relay raddr 0.0.0.0 rport 0`)!);
  b.addRemoteCandidate(parseCandidate(`candidate:1 1 udp 16777215 ${addrA.ip} ${addrA.port} typ relay`)!);
  const connected = (x: IceAgent) => new Promise<void>((resolve) => (x.onConnected = resolve));
  const both = Promise.all([connected(a), connected(b)]);
  a.start();
  b.start();
  let guard: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([both, new Promise((_, reject) => (guard = setTimeout(() => reject(new Error('ICE did not connect')), 3000)))]);
  clearTimeout(guard);
  assert.deepEqual(ta.permits, [addrB.ip]);
  assert.match(a.summary(), /^controlling relay:succeeded\*/);

  const media: number[][] = [];
  b.onPacket = (p) => media.push(Array.from(p));
  assert.ok(a.send(new Uint8Array([0x80, 1, 2, 3])));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(media, [[0x80, 1, 2, 3]]);
  assert.equal(b.receive({ ip: '192.0.2.99', port: 1 }, new Uint8Array([0x80, 9])), false, 'media from an unknown address is dropped');
  a.close();
  b.close();
});

test('calling: RelayMux hands each datagram to the agent whose candidate sent it', () => {
  const turn = { onPeerData: null as ((from: SocketAddress, data: Uint8Array) => void) | null, permit: () => Promise.resolve(), send: () => true };
  const mux = new RelayMux(turn as never);
  const agent = (ip: string) => {
    const ag = new IceAgent({ turn: turn as never, controlling: true, localUfrag: 'u' + ip.slice(-1), localPwd: 'p'.repeat(22) });
    ag.addRemoteCandidate({ address: { ip, port: 9 }, priority: 1, type: 'relay' });
    const got: number[] = [];
    ag.onPacket = (p) => got.push(p[1]);
    mux.add(ag);
    return { ag, got };
  };
  const one = agent('192.0.2.1');
  const two = agent('192.0.2.2');
  turn.onPeerData!({ ip: '192.0.2.2', port: 9 }, new Uint8Array([0x80, 2]));
  turn.onPeerData!({ ip: '192.0.2.1', port: 9 }, new Uint8Array([0x80, 1]));
  turn.onPeerData!({ ip: '192.0.2.3', port: 9 }, new Uint8Array([0x80, 3]));
  mux.remove(two.ag);
  turn.onPeerData!({ ip: '192.0.2.2', port: 9 }, new Uint8Array([0x80, 4]));
  assert.deepEqual(one.got, [1]);
  assert.deepEqual(two.got, [2]);
});

/** Records what it was asked to decode: a packet, its FEC, or concealment. */
class MarkDecoder {
  calls: string[] = [];
  decode(p: Uint8Array, n: number, fec: boolean): Float32Array {
    this.calls.push(`${!p.length ? 'plc' : fec ? 'fec' + p[0] : 'pkt' + p[0]}:${n}`);
    return new Float32Array(n);
  }
}

/** One 60 ms frame on the 48 kHz RTP clock. */
const TS = 2880;
const pkt = (n: number) => new Uint8Array([n]);

test('calling: the jitter buffer plays in order, waits for a reordered packet, and rebuilds a lost one from FEC', () => {
  const d = new MarkDecoder();
  const j = new JitterBuffer(d, 16000);
  assert.equal(j.pull(), null);
  j.push(11, 11 * TS, pkt(11));
  j.push(10, 10 * TS, pkt(10));
  j.pull();
  j.pull();
  j.push(13, 13 * TS, pkt(13));
  assert.equal(j.pull(), null, 'one packet behind a gap may only be reordered');
  j.push(14, 14 * TS, pkt(14));
  j.pull();
  j.pull();
  j.pull();
  j.push(12, 12 * TS, pkt(12));
  assert.equal(j.pull(), null, 'a packet behind playback is dropped');
  assert.deepEqual(d.calls, ['pkt10:960', 'pkt11:960', 'fec13:960', 'pkt13:960', 'pkt14:960']);
});

test('calling: the jitter buffer conceals a burst, fills DTX silence, and drops audio far behind', () => {
  const d = new MarkDecoder();
  const j = new JitterBuffer(d, 16000);
  j.push(10, 10 * TS, pkt(10));
  j.push(13, 13 * TS, pkt(13));
  j.push(14, 14 * TS, pkt(14));
  for (let i = 0; i < 5; i++) j.pull();
  assert.deepEqual(d.calls, ['pkt10:960', 'plc:960', 'fec13:960', 'pkt13:960', 'pkt14:960']);

  d.calls = [];
  j.push(15, 17 * TS, pkt(15));
  for (let i = 0; i < 3; i++) j.pull();
  assert.deepEqual(d.calls, ['plc:960', 'plc:960', 'pkt15:960'], 'two frames of DTX before the next packet');

  d.calls = [];
  for (let s = 16; s < 26; s++) j.push(s, (s + 2) * TS, pkt(s));
  j.pull();
  assert.deepEqual(d.calls, ['pkt21:960'], 'catches up to 300 ms behind the newest packet');
});

test('calling: call audio sends 60 ms frames, skips muted ones, and steps the encoder down when it is slow', () => {
  let t = 0;
  const set: number[] = [];
  const enc = {
    encode: () => {
      t += 40;
      return new Uint8Array(50);
    },
    setComplexity: (c: number) => set.push(c),
  };
  const audio = new CallAudio(enc, new MarkDecoder(), () => t);
  const sent: string[] = [];
  audio.onPacket = (_p, samples, skipped) => sent.push(`${samples}/${skipped}`);
  assert.equal(audio.complexity, OPUS_COMPLEXITY);
  for (let i = 0; i < 25; i++) audio.capture(new Float32Array(480));
  assert.equal(sent.length, 12);
  for (let i = 0; i < 26; i++) audio.capture(new Float32Array(480));
  assert.deepEqual(set, [COMPLEXITY_STEPS[1]]);
  assert.equal(audio.complexity, COMPLEXITY_STEPS[1]);
  audio.muted = true;
  audio.capture(new Float32Array(960));
  audio.muted = false;
  audio.capture(new Float32Array(960));
  assert.equal(sent[0], '2880/0');
  assert.equal(sent[sent.length - 1], '2880/2880');
  audio.close();
});

const PEER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

test('calling: synced call events and call log events become frames naming the 1:1 peer', () => {
  const env = { sourceUuid: 'self', sourceDevice: 1, timestamp: 50 } as never;
  const sync = (content: Record<string, unknown>) => contentToNormalizedFrame(env, create(ContentSchema, { content: { case: 'syncMessage', value: { content } as never } })).envelope.syncMessage;
  const callEvent = sync({ case: 'callEvent', value: { conversationId: uuidToBytes(PEER), callId: 42n, timestamp: 40n, type: SyncMessage_CallEvent_Type.AUDIO_CALL, direction: SyncMessage_CallEvent_Direction.INCOMING, event: SyncMessage_CallEvent_Event.ACCEPTED } });
  assert.deepEqual(callEvent.callEvent, { peer: PEER, callId: '42', timestamp: 40, type: 'audio', direction: 'incoming', event: 'accepted' });
  const group = sync({ case: 'callEvent', value: { conversationId: new Uint8Array(32), callId: 1n, type: SyncMessage_CallEvent_Type.GROUP_CALL, event: SyncMessage_CallEvent_Event.OBSERVED } });
  assert.equal(group.callEvent.peer, undefined);
  assert.equal(group.callEvent.type, 'group');
  const log = sync({ case: 'callLogEvent', value: { type: SyncMessage_CallLogEvent_Type.MARKED_AS_READ_IN_CONVERSATION, timestamp: 45n, conversationId: uuidToBytes(PEER) } });
  assert.deepEqual(log.callLogEvent, { type: 'readInConversation', timestamp: 45, peer: PEER });
});

function offerMsg(id: bigint, video = false): CallMessage {
  const opaque = toBinary(OfferSchema, create(OfferSchema, { v4: create(ConnectionParametersV4Schema, { publicKey: new Uint8Array(32).fill(5), iceUfrag: 'peer', icePwd: 'p'.repeat(22) }) }));
  return create(CallMessageSchema, { offer: create(CallMessage_OfferSchema, { id, type: video ? CallMessage_Offer_Type.OFFER_VIDEO_CALL : CallMessage_Offer_Type.OFFER_AUDIO_CALL, opaque }) });
}

function hangupMsg(id: bigint, type: CallMessage_Hangup_Type, deviceId = 0): CallMessage {
  return create(CallMessageSchema, { hangup: create(CallMessage_HangupSchema, { id, type, deviceId }) });
}

const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

/** A call manager over fakes: messages it sends, chat lines it records, and call events it syncs. */
function callHarness(opts: { identity?: boolean } = {}) {
  const clock = 10_000_000;
  const sent: Array<{ peer: string; msg: CallMessage }> = [];
  const records: CallRecord[] = [];
  const synced: string[] = [];
  const deps: CallDeps = {
    self: async () => ({ aci: 'self', deviceId: 2 }),
    send: async (peer, msg) => {
      sent.push({ peer, msg });
    },
    identityKeys: async () => (opts.identity === false ? null : { ours: new Uint8Array(33).fill(1), theirs: new Uint8Array(33).fill(2) }),
    openRelay: async () => ({ relayed: { ip: '203.0.113.1', port: 4000 }, onPeerData: null, onClosed: null, permit: () => Promise.resolve(), send: () => true, close() {} }) as never,
    newKeys: () => ({ publicKey: () => new Uint8Array(32).fill(3), srtp: () => ({ protectRtp: (p: Uint8Array) => p, unprotectRtp: (p: Uint8Array) => p }) }),
    newAudio: () => new CallAudio({ encode: () => new Uint8Array(40) }, new MarkDecoder()),
    record: (r) => records.push(r),
    syncEvent: (r, e) => synced.push(`${r.direction} ${e}`),
    log: () => {},
    now: () => clock,
  };
  const m = new CallManager(deps);
  const env = (source = PEER, sourceDevice = 1, age = 0) => ({ source, sourceDevice, serverTimestamp: clock - age });
  const kinds = () =>
    sent.map(({ msg }) => (msg.offer ? 'offer' : msg.answer ? 'answer' : msg.iceUpdate.length ? 'ice' : msg.busy ? 'busy' : msg.hangup ? 'hangup ' + CallMessage_Hangup_Type[msg.hangup.type] : '?'));
  return { m, sent, records, synced, env, kinds, outcomes: () => records.map((r) => r.outcome) };
}

test('calling: stale offers are missed calls, video offers are left to the chat line, and offers for other devices are dropped', async () => {
  const h = callHarness();
  assert.equal(await h.m.handle(h.env(PEER, 1, MAX_OFFER_AGE_MS + 1), offerMsg(5n)), true);
  assert.equal(h.m.state, null);
  assert.deepEqual(h.outcomes(), ['missed']);
  assert.equal(await h.m.handle(h.env(), offerMsg(6n, true)), false);
  const elsewhere = offerMsg(7n);
  elsewhere.destinationDeviceId = 3;
  assert.equal(await h.m.handle(h.env(), elsewhere), true);
  assert.equal(h.m.state, null);
  assert.deepEqual(h.sent, []);
});

test('calling: an incoming call rings, answers the offer, and syncs the answer when accepted here', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = callHarness();
  await h.m.handle(h.env(), offerMsg(9n));
  await flush();
  assert.equal(h.m.state!.phase, 'incoming');
  assert.deepEqual(h.kinds(), ['answer', 'ice']);
  assert.ok(h.sent.every((s) => s.peer === PEER && s.msg.destinationDeviceId === 1));
  h.m.accept();
  assert.equal(h.m.state!.phase, 'connecting');
  assert.deepEqual(h.synced, ['incoming accepted']);
  h.m.hangup();
  assert.equal(h.m.state!.endReason, 'hungUp');
  assert.deepEqual(h.kinds().slice(2), ['hangup HANGUP_NORMAL']);
  assert.deepEqual(h.outcomes(), ['accepted'], 'answered, even though no audio flowed yet');
  h.m.dismiss();
  assert.equal(h.m.state, null);
});

test('calling: another caller gets busy only while a call is live', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = callHarness();
  await h.m.handle(h.env(PEER, 1), offerMsg(9n));
  await flush();
  await h.m.handle(h.env(OTHER, 4), offerMsg(10n));
  await flush();
  assert.equal(h.m.state!.peer, PEER);
  const busy = h.sent.filter((s) => s.msg.busy);
  assert.deepEqual(
    busy.map((s) => [s.peer, s.msg.destinationDeviceId]),
    [[OTHER, 4]]
  );
  assert.deepEqual(
    h.records.map((r) => [r.peer, r.outcome]),
    [[OTHER, 'missed']]
  );
  h.m.decline();
  assert.deepEqual(h.synced, ['incoming notAccepted']);
  await h.m.handle(h.env(OTHER, 4), offerMsg(11n));
  await flush();
  assert.equal(h.m.state!.peer, OTHER);
  assert.equal(h.m.state!.phase, 'incoming');
  assert.equal(h.sent.filter((s) => s.msg.busy).length, 1);
});

test('calling: a call answered or declined on another device stops ringing here without a hangup from us', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = callHarness();
  await h.m.handle(h.env(), offerMsg(9n));
  await flush();
  await h.m.handle(h.env(), hangupMsg(9n, CallMessage_Hangup_Type.HANGUP_ACCEPTED, 2));
  assert.equal(h.m.state!.phase, 'incoming', 'a hangup naming this device is about this device');
  await h.m.handle(h.env(), hangupMsg(9n, CallMessage_Hangup_Type.HANGUP_ACCEPTED, 3));
  assert.equal(h.m.state!.endReason, 'acceptedElsewhere');
  assert.deepEqual(h.outcomes(), ['accepted']);

  const s = callHarness();
  await s.m.handle(s.env(), offerMsg(12n));
  await flush();
  s.m.answeredElsewhere('13', false);
  assert.equal(s.m.state!.phase, 'incoming', 'a sync for another call is ignored');
  s.m.answeredElsewhere('12', false);
  assert.equal(s.m.state!.endReason, 'declinedElsewhere');
  assert.deepEqual(s.outcomes(), ['declined']);
  for (const x of [h, s]) assert.ok(!x.sent.some((m) => m.msg.hangup));
});

test('calling: a call that rings out, fails before it is answered, or is ignored ends without a hangup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = callHarness();
  await h.m.handle(h.env(), offerMsg(9n));
  await flush();
  t.mock.timers.tick(RING_TIMEOUT_MS);
  assert.equal(h.m.state!.endReason, 'missed');

  const f = callHarness({ identity: false });
  await f.m.handle(f.env(), offerMsg(10n));
  await flush();
  assert.equal(f.m.state!.endReason, 'failed');
  assert.deepEqual(f.kinds(), []);

  const i = callHarness();
  await i.m.handle(i.env(), offerMsg(11n));
  await flush();
  i.m.ignore();
  assert.equal(i.m.state!.endReason, 'missed');
  assert.deepEqual(i.synced, []);
  for (const x of [h, f, i]) {
    assert.ok(!x.sent.some((m) => m.msg.hangup));
    assert.deepEqual(x.outcomes(), ['missed']);
  }
});

test('calling: an outgoing call offers, syncs that it was placed, and hangs up when nobody answers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = callHarness();
  await h.m.startCall(PEER);
  assert.equal(h.m.state!.phase, 'outgoing');
  assert.deepEqual(h.kinds(), ['offer', 'ice']);
  assert.deepEqual(h.synced, ['outgoing accepted']);
  await assert.rejects(h.m.startCall(OTHER), /already in a call/);
  t.mock.timers.tick(RING_TIMEOUT_MS);
  assert.equal(h.m.state!.endReason, 'noAnswer');
  assert.deepEqual(h.kinds().slice(2), ['hangup HANGUP_NORMAL']);
  assert.deepEqual(h.outcomes(), ['unanswered']);
});

test('calling: glare between two calls to each other keeps the one with the higher call ID', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = callHarness();
  await h.m.startCall(PEER);
  const ours = BigInt(h.m.state!.callId);
  await h.m.handle(h.env(PEER, 1), offerMsg(ours - 1n));
  await flush();
  assert.equal(h.m.state!.callId, ours.toString());
  assert.equal(h.m.state!.direction, 'outgoing');
  assert.ok(!h.sent.some((s) => s.msg.hangup || s.msg.busy));

  await h.m.handle(h.env(PEER, 1), offerMsg(ours + 1n));
  await flush();
  assert.equal(h.m.state!.direction, 'incoming');
  assert.equal(h.m.state!.callId, (ours + 1n).toString());
  assert.ok(h.sent.some((s) => s.msg.hangup && s.msg.hangup.id === ours));
});
