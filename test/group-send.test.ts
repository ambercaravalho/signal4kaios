/* Sender Key group sends: the wasm exports against Signal's official library acting as the server (multi-recipient Sealed Sender, group send endorsements), and SignalClient's multi_recipient path with its device fixes and fallback. */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as official from '@signalapp/libsignal-client';
import SealedSenderMultiRecipientMessage from '@signalapp/libsignal-client/dist/SealedSenderMultiRecipientMessage.js';
import * as zk from '@signalapp/libsignal-client/zkgroup';

import { fromBase64, randomBytes, toBase64 } from '../src/engine/bytes';
import { padMessagePlaintext, unpadMessagePlaintext } from '../src/engine/crypto/primitives';
import { ContentSchema } from '../src/engine/gen/SignalService_pb';
import { SenderKeyGroup, SignalClient } from '../src/engine/net/client';
import { create, fromBinary } from '../src/engine/net/proto';
import {
  CIPHERTEXT_SENDERKEY,
  createSenderKeyDistribution,
  decryptPreKey,
  decryptSenderKey,
  decryptWhisper,
  localIdentity,
  processSenderKeyDistribution,
  senderKeyMultiRecipientEncrypt,
  unseal,
} from '../src/engine/protocol/protocol';
import { MemorySignalStore } from '../src/engine/protocol/store';
import {
  analyzeSenderKeyDevices,
  endorsesAll,
  groupSendToken,
  loadGroupSendEndorsements,
  loadSenderKeyInfo,
  storeGroupSendEndorsements,
} from '../src/engine/services/group-send';
import { deriveGroupV2Keys } from '../src/engine/services/groups-v2';
import { libsignal } from '../src/engine/protocol/libsignal';
import { connect, loadWasmForTests, newAccount, serverKeysFor, TestAccount } from './support';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const DAVE = '44444444-4444-4444-8444-444444444444';
const u8 = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);
const DAY = 86400000;

before(() => {
  loadWasmForTests();
});

const trustRoot = official.PrivateKey.generate();
const serverKey = official.PrivateKey.generate();
const serverCert = official.ServerCertificate.new(1, serverKey.getPublicKey(), trustRoot);
const roots = () => u8(trustRoot.getPublicKey().serialize());

function senderCertificate(acc: TestAccount): Uint8Array {
  const key = official.PublicKey.deserialize(u8(acc.identityPublic));
  return u8(official.SenderCertificate.new(acc.aci, null, acc.deviceId, key, Date.now() + DAY, serverCert, serverKey).serialize());
}

/** Another device of the same account: same identity key, its own registration ID and PreKeys. */
async function siblingDevice(acc: TestAccount, deviceId: number): Promise<TestAccount> {
  const creds = (await acc.store.getAccount())!;
  const store = new MemorySignalStore({ ...creds, deviceId, registrationId: libsignal.generateRegistrationId() });
  return { aci: acc.aci, deviceId, store, identityPublic: acc.identityPublic };
}

/** A day-aligned expiration between 3 and 27 hours away, as the storage server issues them. */
function endorsementExpiration(): Date {
  let exp = Math.ceil(Date.now() / DAY) * DAY;
  if (exp - Date.now() < 3 * 3600000) exp += DAY;
  return new Date(exp);
}

/** The storage server's side: endorsements for every member of a group, and the key pair the chat server checks tokens with. */
function issueEndorsements(secretParams: Uint8Array, members: string[]) {
  const serverSecret = zk.ServerSecretParams.generate();
  const serverPublic = u8(serverSecret.getPublicParams().serialize());
  const cipher = new zk.ClientZkGroupCipher(new zk.GroupSecretParams(u8(secretParams)));
  const keyPair = zk.GroupSendDerivedKeyPair.forExpiration(endorsementExpiration(), serverSecret);
  const response = zk.GroupSendEndorsementsResponse.issue(
    members.map((m) => cipher.encryptServiceId(official.Aci.fromUuid(m))),
    keyPair
  );
  return { serverPublic, keyPair, response: u8(response.serialize()) };
}

function verifyToken(token: string, keyPair: zk.GroupSendDerivedKeyPair, acis: string[]): boolean {
  try {
    new zk.GroupSendFullToken(u8(fromBase64(token))).verify(acis.map((a) => official.Aci.fromUuid(a)), keyPair);
    return true;
  } catch {
    return false;
  }
}

describe('Sender Key wasm exports against the official library', () => {
  it('seals one sender key message for several devices that each recipient opens', async () => {
    const dist = '55555555-5555-4555-8555-555555555555';
    const alice = newAccount(ALICE, 2);
    const bob = newAccount(BOB, 1);
    const carol = newAccount(CAROL, 1);
    await connect(alice, bob);
    await connect(alice, carol);
    const local = await localIdentity(alice.store);
    const skdm = await createSenderKeyDistribution(alice.store, local, dist);
    const groupId = randomBytes(32);
    const content = padMessagePlaintext(new TextEncoder().encode('to everyone'));
    const body = await senderKeyMultiRecipientEncrypt(
      alice.store,
      local,
      dist,
      [{ name: CAROL, deviceId: 1 }, { name: BOB, deviceId: 1 }],
      senderCertificate(alice),
      content,
      0,
      groupId
    );

    const mrm = new SealedSenderMultiRecipientMessage(u8(body));
    const recipients = mrm.recipientsByServiceIdString();
    assert.deepEqual(Object.keys(recipients).sort(), [BOB, CAROL]);
    assert.deepEqual(recipients[BOB].deviceIds, [1]);
    assert.deepEqual(recipients[BOB].registrationIds, [(await bob.store.getAccount())!.registrationId]);

    for (const who of [bob, carol]) {
      const whoLocal = await localIdentity(who.store);
      await processSenderKeyDistribution(who.store, whoLocal, ALICE, 2, skdm);
      const opened = await unseal(who.store, whoLocal, u8(mrm.messageForRecipient(recipients[who.aci])), Date.now(), roots());
      assert.equal(opened.messageType, CIPHERTEXT_SENDERKEY);
      assert.equal(opened.senderUuid, ALICE);
      assert.deepEqual(opened.groupId, groupId);
      assert.deepEqual(await decryptSenderKey(who.store, whoLocal, ALICE, 2, opened.contents), content);
    }
  });

  it('receives endorsements from the server and builds tokens the server accepts', async () => {
    const keys = deriveGroupV2Keys(randomBytes(32));
    const srv = issueEndorsements(keys.secretParams, [ALICE, BOB, CAROL]);
    const store = newAccount(ALICE, 2).store;
    const e = await storeGroupSendEndorsements(store, keys.internalId, keys.secretParams, srv.serverPublic, srv.response, [ALICE, BOB, CAROL]);
    assert.ok(e);
    assert.equal(e.expiration * 1000, endorsementExpiration().getTime());
    assert.deepEqual(await loadGroupSendEndorsements(store, keys.internalId), e);
    assert.ok(endorsesAll(e, [BOB, CAROL]));
    assert.ok(!endorsesAll(e, [BOB, DAVE]));

    const token = groupSendToken(e, keys.secretParams, [BOB, CAROL]);
    assert.ok(verifyToken(token, srv.keyPair, [BOB, CAROL]));
    assert.ok(!verifyToken(token, srv.keyPair, [ALICE, BOB, CAROL]), 'the token covers exactly who it was built for');
    assert.ok(verifyToken(groupSendToken(e, keys.secretParams, [CAROL]), srv.keyPair, [CAROL]));

    assert.equal(await loadGroupSendEndorsements(store, keys.internalId, e.expiration * 1000 - 3600000), null, 'endorsements that expire within two hours are not used');
    const other = issueEndorsements(keys.secretParams, [ALICE, BOB]);
    await assert.rejects(storeGroupSendEndorsements(store, keys.internalId, keys.secretParams, srv.serverPublic, other.response, [ALICE, BOB]), 'endorsements from another server are rejected');
  });

  it('finds devices that need our sender key and devices that left', () => {
    const had = [{ aci: BOB, deviceId: 1, registrationId: 7 }, { aci: CAROL, deviceId: 1, registrationId: 8 }];
    const now = [{ aci: BOB, deviceId: 1, registrationId: 9 }, { aci: DAVE, deviceId: 3, registrationId: 1 }];
    const res = analyzeSenderKeyDevices(had, now);
    assert.deepEqual(res.newAcis, [BOB, DAVE], 'a re-registered device needs the key again');
    assert.deepEqual(res.removedAcis, [BOB, CAROL]);
    assert.equal(res.removedDevices.length, 2);
  });
});

describe('SignalClient Sender Key group sends', () => {
  interface Call {
    method: string;
    path: string;
    body: any;
    opts: any;
  }

  async function setup(peerIds: string[]) {
    const alice = newAccount(ALICE, 2);
    const peers = new Map<string, TestAccount>();
    for (const id of peerIds) peers.set(id, newAccount(id, 1));
    const extra = new Map<string, TestAccount>();
    const keys = deriveGroupV2Keys(randomBytes(32));
    const srv = issueEndorsements(keys.secretParams, [ALICE, ...peerIds]);
    const endorsements = await storeGroupSendEndorsements(alice.store, keys.internalId, keys.secretParams, srv.serverPublic, srv.response, [ALICE, ...peerIds]);
    const cert = senderCertificate(alice);
    const calls: Call[] = [];
    const mrm: Array<(body: Uint8Array) => any> = [];
    const httpJson = async (method: string, path: string, body: any, opts: any) => {
      calls.push({ method, path, body, opts });
      if (path.startsWith('/v1/certificate/delivery')) return { certificate: toBase64(cert) };
      const k = /^\/v2\/keys\/([^/]+)\/(.+)$/.exec(path);
      if (k) {
        const acc = k[2] === '*' || k[2] === '1' ? peers.get(k[1]) : extra.get(k[1] + '.' + k[2]);
        if (!acc) throw Object.assign(new Error('HTTP 404'), { status: 404 });
        return serverKeysFor(acc);
      }
      if (path.startsWith('/v1/messages/multi_recipient')) {
        const next = mrm.shift();
        return next ? next(body) : { uuids404: [] };
      }
      if (path.startsWith('/v1/messages/')) return {};
      throw new Error('unexpected ' + method + ' ' + path);
    };
    const client = new SignalClient(alice.store, httpJson, async () => new Uint8Array(0));
    const group: SenderKeyGroup = { internalId: keys.internalId, secretParams: keys.secretParams, endorsements };
    const content = (text: string) => create(ContentSchema, { content: { case: 'dataMessage', value: { body: text, timestamp: 1n } } });
    const puts = (prefix: string) => calls.filter((c) => c.method === 'PUT' && c.path.startsWith(prefix));
    const oneToOne = () => calls.filter((c) => c.method === 'PUT' && /^\/v1\/messages\/[0-9a-f-]{36}$/.test(c.path)).map((c) => c.path.slice('/v1/messages/'.length));

    /** What `who` reads: their copy of our SenderKeyDistributionMessage (from 1:1 sends) and the last multi_recipient message. */
    async function readAs(who: TestAccount, deviceId = 1): Promise<string> {
      const local = await localIdentity(who.store);
      for (const c of puts('/v1/messages/' + who.aci)) {
        const m = c.body.messages.find((x: any) => x.destinationDeviceId === deviceId);
        if (!m || m.read) continue;
        m.read = true;
        const raw = fromBase64(m.content);
        const res = m.type === 3 ? await decryptPreKey(who.store, local, ALICE, 2, raw) : await decryptWhisper(who.store, local, ALICE, 2, raw);
        const skdm = fromBinary(ContentSchema, unpadMessagePlaintext(res.plaintext)).senderKeyDistributionMessage;
        if (skdm.length) await processSenderKeyDistribution(who.store, local, ALICE, 2, skdm);
      }
      const last = puts('/v1/messages/multi_recipient').pop()!;
      const parsed = new SealedSenderMultiRecipientMessage(u8(last.body));
      const opened = await unseal(who.store, local, u8(parsed.messageForRecipient(parsed.recipientsByServiceIdString()[who.aci])), Date.now(), roots());
      const plain = await decryptSenderKey(who.store, local, ALICE, 2, opened.contents);
      const c = fromBinary(ContentSchema, unpadMessagePlaintext(plain)).content;
      return c.case === 'dataMessage' ? c.value.body || '' : '';
    }

    return { alice, peers, extra, keys, srv, calls, mrm, client, group, content, puts, oneToOne, readAs };
  }

  it('gives members our sender key once, then sends one multi_recipient message with a Group-Send-Token', async () => {
    const t = await setup([BOB, CAROL]);
    assert.equal(await t.client.sendGroupContent([BOB, CAROL, ALICE], t.content('hello group'), 1000, false, t.group), true);
    assert.deepEqual(t.oneToOne().sort(), [BOB, CAROL].sort(), 'each member gets our sender key first');
    const [send] = t.puts('/v1/messages/multi_recipient');
    assert.match(send.path, /^\/v1\/messages\/multi_recipient\?ts=1000&online=false&urgent=true&story=false$/);
    assert.equal(send.opts.noAuth, true);
    assert.equal(send.opts.headers['Content-Type'], 'application/vnd.signal-messenger.mrm');
    assert.ok(verifyToken(send.opts.headers['Group-Send-Token'], t.srv.keyPair, [BOB, CAROL]));
    assert.equal(await t.readAs(t.peers.get(BOB)!), 'hello group');
    assert.equal(await t.readAs(t.peers.get(CAROL)!), 'hello group');

    t.calls.length = 0;
    await t.client.sendGroupContent([BOB, CAROL], t.content('again'), 2000, false, t.group);
    assert.deepEqual(t.oneToOne(), [], 'members who have the key are not sent it again');
    assert.equal(t.puts('/v1/messages/multi_recipient').length, 1);
    assert.equal(await t.readAs(t.peers.get(BOB)!), 'again');
  });

  it('starts a new sender key when a member leaves, and only gives it to newcomers after that', async () => {
    const t = await setup([BOB, CAROL, DAVE]);
    await t.client.sendGroupContent([BOB, CAROL, DAVE], t.content('three'), 1000, false, t.group);
    const first = (await loadSenderKeyInfo(t.alice.store, t.keys.internalId)).distributionId;

    t.calls.length = 0;
    await t.client.sendGroupContent([BOB, CAROL], t.content('two'), 2000, false, t.group);
    const second = await loadSenderKeyInfo(t.alice.store, t.keys.internalId);
    assert.notEqual(second.distributionId, first);
    assert.deepEqual(t.oneToOne().sort(), [BOB, CAROL].sort());
    assert.deepEqual(second.memberDevices.map((d) => d.aci).sort(), [BOB, CAROL].sort());
    const parsed = new SealedSenderMultiRecipientMessage(u8(t.puts('/v1/messages/multi_recipient')[0].body));
    assert.deepEqual(Object.keys(parsed.recipientsByServiceIdString()).sort(), [BOB, CAROL].sort());
    assert.equal(await t.readAs(t.peers.get(CAROL)!), 'two');

    t.calls.length = 0;
    await t.client.sendGroupContent([BOB, CAROL, DAVE], t.content('back'), 3000, false, t.group);
    assert.deepEqual(t.oneToOne(), [DAVE]);
    assert.equal((await loadSenderKeyInfo(t.alice.store, t.keys.internalId)).distributionId, second.distributionId);
  });

  it('adds a device the server says is missing and retries once', async () => {
    const t = await setup([BOB, CAROL]);
    const carol2 = await siblingDevice(t.peers.get(CAROL)!, 2);
    t.extra.set(CAROL + '.2', carol2);
    t.mrm.push(() => {
      throw Object.assign(new Error('HTTP 409'), { status: 409, body: [{ uuid: CAROL, devices: { missingDevices: [2], extraDevices: [] } }] });
    });
    assert.equal(await t.client.sendGroupContent([BOB, CAROL], t.content('both phones'), 1000, false, t.group), true);
    const sends = t.puts('/v1/messages/multi_recipient');
    assert.equal(sends.length, 2);
    const parsed = new SealedSenderMultiRecipientMessage(u8(sends[1].body));
    assert.deepEqual(parsed.recipientsByServiceIdString()[CAROL].deviceIds, [1, 2]);
    assert.equal(t.oneToOne().filter((id) => id === CAROL).length, 2, 'the new device gets our sender key');
    assert.equal(await t.readAs(carol2, 2), 'both phones');
  });

  it('sends to each member when multi_recipient fails, and skips members the server says are gone', async () => {
    const t = await setup([BOB, CAROL]);
    t.mrm.push(() => {
      throw Object.assign(new Error('HTTP 500'), { status: 500 });
    });
    t.calls.length = 0;
    assert.equal(await t.client.sendGroupContent([BOB, CAROL], t.content('fallback'), 1000, false, t.group), false);
    const after = t.calls.findIndex((c) => c.path.startsWith('/v1/messages/multi_recipient'));
    const fanout = t.calls.slice(after + 1).filter((c) => c.method === 'PUT').map((c) => c.path);
    assert.deepEqual(fanout.sort(), ['/v1/messages/' + BOB, '/v1/messages/' + CAROL].sort());

    t.calls.length = 0;
    t.mrm.push(() => ({ uuids404: [CAROL] }));
    await t.client.sendGroupContent([BOB, CAROL], t.content('one left'), 2000, false, t.group);
    assert.deepEqual(t.oneToOne(), [], 'nobody gets a separate copy');

    t.calls.length = 0;
    await t.client.sendGroupContent([BOB, CAROL], t.content('no group'), 3000, false, { ...t.group, endorsements: null });
    assert.equal(t.puts('/v1/messages/multi_recipient').length, 0);
    assert.deepEqual(t.oneToOne().sort(), [BOB, CAROL].sort());
  });
});
