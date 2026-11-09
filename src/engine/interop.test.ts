/* Interop tests: our libsignal wasm build against Signal's official Node library (@signalapp/libsignal-client, same libsignal release), plus known-answer vectors. */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as official from '@signalapp/libsignal-client';
import { AccountEntropyPool } from '@signalapp/libsignal-client/dist/AccountKeys.js';
import { encryptProvisionMessage, RecvProvisionCiphertextState } from '@signalapp/libsignal-client/dist/Provisioning.js';
import * as zk from '@signalapp/libsignal-client/zkgroup';

import { fromBase64, fromHex, randomBytes, toBase64, toHex, uuidToBytes } from './bytes';
import { deriveGroupV2Keys } from './groups-v2';
import { libsignal } from './libsignal';
import { decryptProfileName } from './profiles';
import {
  decryptPreKey,
  decryptSenderKey,
  decryptWhisper,
  encryptForDevice,
  localIdentity,
  parsePreKeyResponse,
  processPreKeyBundle,
  processSenderKeyDistribution,
  safetyNumber,
  sealedEncryptForDevice,
  unseal,
} from './protocol';
import { deriveStorageItemKey, deriveStorageManifestKey, deriveStorageServiceKey } from './storage-service';
import { loadWasmForTests, newAccount, serverKeysFor } from './test-support';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const text = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(s));
const u8 = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

before(() => {
  loadWasmForTests();
});

/** In-memory implementation of every libsignal-client store interface. */
class OfficialStore {
  sessions = new Map<string, official.SessionRecord>();
  identities = new Map<string, official.PublicKey>();
  preKeys = new Map<number, official.PreKeyRecord>();
  signedPreKeys = new Map<number, official.SignedPreKeyRecord>();
  kyberPreKeys = new Map<number, official.KyberPreKeyRecord>();
  senderKeys = new Map<string, official.SenderKeyRecord>();

  constructor(readonly identity: official.IdentityKeyPair, readonly registrationId: number) {}

  private key(a: official.ProtocolAddress) {
    return `${a.name()}.${a.deviceId()}`;
  }
  async saveSession(a: official.ProtocolAddress, r: official.SessionRecord) { this.sessions.set(this.key(a), r); }
  async getSession(a: official.ProtocolAddress) { return this.sessions.get(this.key(a)) || null; }
  async getExistingSessions(as: official.ProtocolAddress[]) { return as.map((a) => this.sessions.get(this.key(a))!).filter(Boolean); }
  async getIdentityKey() { return this.identity.privateKey; }
  async getIdentityKeyPair() { return this.identity; }
  async getLocalRegistrationId() { return this.registrationId; }
  async saveIdentity(a: official.ProtocolAddress, k: official.PublicKey) {
    const prev = this.identities.get(a.name());
    this.identities.set(a.name(), k);
    return prev && !prev.equals(k) ? official.IdentityChange.ReplacedExisting : official.IdentityChange.NewOrUnchanged;
  }
  async isTrustedIdentity() { return true; }
  async getIdentity(a: official.ProtocolAddress) { return this.identities.get(a.name()) || null; }
  async savePreKey(id: number, r: official.PreKeyRecord) { this.preKeys.set(id, r); }
  async getPreKey(id: number) { return this.preKeys.get(id)!; }
  async removePreKey(id: number) { this.preKeys.delete(id); }
  async saveSignedPreKey(id: number, r: official.SignedPreKeyRecord) { this.signedPreKeys.set(id, r); }
  async getSignedPreKey(id: number) { return this.signedPreKeys.get(id)!; }
  async saveKyberPreKey(id: number, r: official.KyberPreKeyRecord) { this.kyberPreKeys.set(id, r); }
  async getKyberPreKey(id: number) { return this.kyberPreKeys.get(id)!; }
  async markKyberPreKeyUsed() {}
  async saveSenderKey(a: official.ProtocolAddress, dist: string, r: official.SenderKeyRecord) { this.senderKeys.set(`${this.key(a)}::${dist}`, r); }
  async getSenderKey(a: official.ProtocolAddress, dist: string) { return this.senderKeys.get(`${this.key(a)}::${dist}`) || null; }
}

/** An official-library account with one published PreKey bundle, as the server would return it from `GET /v2/keys`. */
function officialAccount() {
  const identity = official.IdentityKeyPair.generate();
  const store = new OfficialStore(identity, 4242);
  const pre = official.PrivateKey.generate();
  store.preKeys.set(1, official.PreKeyRecord.new(1, pre.getPublicKey(), pre));
  const spk = official.PrivateKey.generate();
  const spkSig = identity.privateKey.sign(spk.getPublicKey().serialize());
  store.signedPreKeys.set(2, official.SignedPreKeyRecord.new(2, Date.now(), spk.getPublicKey(), spk, spkSig));
  const kem = official.KEMKeyPair.generate();
  const kemSig = identity.privateKey.sign(kem.getPublicKey().serialize());
  store.kyberPreKeys.set(3, official.KyberPreKeyRecord.new(3, Date.now(), kem, kemSig));
  const serverJson = {
    identityKey: toBase64(identity.publicKey.serialize()),
    devices: [
      {
        deviceId: 1,
        registrationId: 4242,
        preKey: { keyId: 1, publicKey: toBase64(pre.getPublicKey().serialize()) },
        signedPreKey: { keyId: 2, publicKey: toBase64(spk.getPublicKey().serialize()), signature: toBase64(spkSig) },
        pqPreKey: { keyId: 3, publicKey: toBase64(kem.getPublicKey().serialize()), signature: toBase64(kemSig) },
      },
    ],
  };
  return { identity, store, serverJson };
}

const addr = (name: string, device: number) => official.ProtocolAddress.new(name, device);

describe('Interop: 1:1 sessions (PQXDH + ratchet)', () => {
  it('our PreKey message decrypts in the official library, and its reply decrypts here', async () => {
    const alice = newAccount(ALICE, 2);
    const bob = officialAccount();
    const [bundle] = parsePreKeyResponse(bob.serverJson);
    await alice.store.saveIdentity(BOB, bundle.identityKey, { uuid: BOB });
    const aliceLocal = await localIdentity(alice.store);
    await processPreKeyBundle(alice.store, aliceLocal, BOB, bundle);

    const msg = await encryptForDevice(alice.store, aliceLocal, BOB, 1, text('hi from wasm'));
    assert.equal(msg.envelopeType, 3);
    const s = bob.store as any;
    const pt = await official.signalDecryptPreKey(official.PreKeySignalMessage.deserialize(u8(msg.body)), addr(ALICE, 2), addr(BOB, 1), s, s, s, s, s);
    assert.deepEqual(u8(pt), text('hi from wasm'));
    assert.equal(bob.store.preKeys.size, 0);

    const reply = await official.signalEncrypt(text('hi from node'), addr(ALICE, 2), addr(BOB, 1), s, s);
    assert.equal(reply.type(), official.CiphertextMessageType.Whisper);
    assert.deepEqual((await decryptWhisper(alice.store, aliceLocal, BOB, 1, u8(reply.serialize()))).plaintext, text('hi from node'));
  });

  it('the official library builds a session from our published keys', async () => {
    const bob = newAccount(BOB, 1);
    const keys = await serverKeysFor(bob);
    const d = keys.devices[0];
    const alice = officialAccount();
    const s = alice.store as any;
    const bundle = official.PreKeyBundle.new(
      d.registrationId,
      1,
      d.preKey.keyId,
      official.PublicKey.deserialize(u8(fromBase64(d.preKey.publicKey))),
      d.signedPreKey.keyId,
      official.PublicKey.deserialize(u8(fromBase64(d.signedPreKey.publicKey))),
      u8(fromBase64(d.signedPreKey.signature)),
      official.PublicKey.deserialize(u8(fromBase64(keys.identityKey))),
      d.pqPreKey.keyId,
      official.KEMPublicKey.deserialize(u8(fromBase64(d.pqPreKey.publicKey))),
      u8(fromBase64(d.pqPreKey.signature))
    );
    await official.processPreKeyBundle(bundle, addr(BOB, 1), addr(ALICE, 2), s, s);
    const msg = await official.signalEncrypt(text('node first'), addr(BOB, 1), addr(ALICE, 2), s, s);
    assert.equal(msg.type(), official.CiphertextMessageType.PreKey);

    const bobLocal = await localIdentity(bob.store);
    const res = await decryptPreKey(bob.store, bobLocal, ALICE, 2, u8(msg.serialize()));
    assert.deepEqual(res.plaintext, text('node first'));

    const back = await encryptForDevice(bob.store, bobLocal, ALICE, 2, text('wasm reply'));
    assert.equal(back.envelopeType, 1);
    const pt = await official.signalDecrypt(official.SignalMessage.deserialize(u8(back.body)), addr(BOB, 1), addr(ALICE, 2), s, s);
    assert.deepEqual(u8(pt), text('wasm reply'));
  });
});

describe('Interop: Sealed Sender', () => {
  it('seals and unseals across implementations with a certificate chain from a test trust root', async () => {
    const trustRoot = official.PrivateKey.generate();
    const serverKey = official.PrivateKey.generate();
    const serverCert = official.ServerCertificate.new(1, serverKey.getPublicKey(), trustRoot);
    const expires = Date.now() + 3600_000;

    // wasm Alice -> official Bob
    const alice = newAccount(ALICE, 2);
    const bob = officialAccount();
    const [bundle] = parsePreKeyResponse(bob.serverJson);
    await alice.store.saveIdentity(BOB, bundle.identityKey, { uuid: BOB });
    const aliceLocal = await localIdentity(alice.store);
    await processPreKeyBundle(alice.store, aliceLocal, BOB, bundle);
    const aliceCert = official.SenderCertificate.new(ALICE, null, 2, official.PublicKey.deserialize(u8(alice.identityPublic)), expires, serverCert, serverKey);
    const sealed = await sealedEncryptForDevice(alice.store, aliceLocal, BOB, 1, u8(aliceCert.serialize()), text('sealed hello'));
    const s = bob.store as any;
    const opened = await official.sealedSenderDecryptMessage(u8(sealed.body), trustRoot.getPublicKey(), Date.now(), null, BOB, 1, s, s, s, s, s);
    assert.equal(opened.senderUuid(), ALICE);
    assert.equal(opened.deviceId(), 2);
    assert.deepEqual(u8(opened.message()), text('sealed hello'));

    // official Bob -> wasm Alice, over the session Bob now holds
    const bobCert = official.SenderCertificate.new(BOB, null, 1, bob.identity.publicKey, expires, serverCert, serverKey);
    const back = await official.sealedSenderEncryptMessage(text('sealed reply'), addr(ALICE, 2), bobCert, s, s);
    const roots = u8(trustRoot.getPublicKey().serialize());
    const unsealed = await unseal(alice.store, aliceLocal, u8(back), Date.now(), roots);
    assert.equal(unsealed.senderUuid, BOB);
    assert.equal(unsealed.senderDeviceId, 1);
    assert.deepEqual((await decryptWhisper(alice.store, aliceLocal, BOB, 1, unsealed.contents)).plaintext, text('sealed reply'));

    // A certificate from a different root is rejected
    await assert.rejects(unseal(alice.store, aliceLocal, u8(back), Date.now(), u8(official.PrivateKey.generate().getPublicKey().serialize())));
  });
});

describe('Interop: Sender Keys', () => {
  it('group messages decrypt across implementations in both directions', async () => {
    const dist = '33333333-3333-4333-8333-333333333333';
    const alice = newAccount(ALICE, 2);
    const aliceLocal = await localIdentity(alice.store);
    const bob = officialAccount();
    const s = bob.store as any;

    const ps = new libsignal.ProtocolStore(aliceLocal.keyPair.pubKey, aliceLocal.keyPair.privKey, aliceLocal.registrationId);
    const skdm = libsignal.createSenderKeyDistributionMessage(ps, ALICE, 2, dist);
    const ct = libsignal.groupEncrypt(ps, ALICE, 2, dist, text('wasm group'));
    ps.free();
    await official.processSenderKeyDistributionMessage(addr(ALICE, 2), official.SenderKeyDistributionMessage.deserialize(u8(skdm)), s);
    assert.deepEqual(u8(await official.groupDecrypt(addr(ALICE, 2), s, u8(ct))), text('wasm group'));

    const bobSkdm = await official.SenderKeyDistributionMessage.create(addr(BOB, 1), dist, s);
    const bobCt = await official.groupEncrypt(addr(BOB, 1), dist, s, text('node group'));
    await processSenderKeyDistribution(alice.store, aliceLocal, BOB, 1, u8(bobSkdm.serialize()));
    assert.deepEqual(await decryptSenderKey(alice.store, aliceLocal, BOB, 1, u8(bobCt.serialize())), text('node group'));
  });
});

describe('Interop: identity and account keys', () => {
  it('safety numbers match the official library and libsignal known answers', () => {
    const a = official.IdentityKeyPair.generate().publicKey;
    const b = official.IdentityKeyPair.generate().publicKey;
    const ours = safetyNumber(ALICE, u8(a.serialize()), BOB, u8(b.serialize()));
    const theirs = official.Fingerprint.new(5200, 2, u8(uuidToBytes(ALICE)), a, u8(uuidToBytes(BOB)), b);
    assert.equal(ours.safetyNumber, theirs.displayableFingerprint().toString());
    assert.deepEqual(ours.scannable, u8(theirs.scannableFingerprint().toBuffer()));

    // rust/protocol/src/fingerprint.rs fingerprint_test_v2
    const kat = libsignal.fingerprintCreate(
      2,
      5200,
      text('+14152222222'),
      fromHex('0506863bc66d02b40d27b8d49ca7c09e9239236f9d7d25d6fcca5ce13c7064d868'),
      text('+14153333333'),
      fromHex('05f781b6fb32fed9ba1cf2de978d4d5da28dc34046ae814402b5c0dbd96fda907b')
    ) as { displayable: string; scannable: Uint8Array };
    assert.equal(kat.displayable, '300354477692869396892869876765458257569162576843440918079131');
    assert.equal(
      toHex(kat.scannable),
      '080212220a201e301a0353dce3dbe7684cb8336e85136cdc0ee96219494ada305d62a7bd61df1a220a20d62cbf73a11592015b6b9f1682ac306fea3aaf3885b84d12bca631e9d4fb3a4d'
    );
  });

  it('username hashes, Account Entropy Pool master keys, and Kyber records match', () => {
    for (const name of ['alice.42', 'He110.01', '_identifier.42']) {
      assert.deepEqual(libsignal.usernameHash(name), u8(official.usernames.hash(name)));
    }

    const aep = AccountEntropyPool.generate();
    assert.deepEqual(libsignal.accountEntropyPoolDeriveMasterKey(aep), u8(AccountEntropyPool.deriveSvrKey(aep)));

    const identity = official.IdentityKeyPair.generate();
    const kem = official.KEMKeyPair.generate();
    const record = official.KyberPreKeyRecord.new(9, Date.now(), kem, identity.privateKey.sign(kem.getPublicKey().serialize()));
    const enc = libsignal.kemEncapsulate(u8(kem.getPublicKey().serialize())) as { ciphertext: Uint8Array; sharedSecret: Uint8Array };
    assert.deepEqual(libsignal.kyberPreKeyRecordDecapsulate(u8(record.serialize()), enc.ciphertext), enc.sharedSecret);

    const ours = libsignal.kyberPreKeyRecordGenerate(5, Date.now(), u8(identity.privateKey.serialize())) as { record: Uint8Array; publicKey: Uint8Array };
    const parsed = official.KyberPreKeyRecord.deserialize(u8(ours.record));
    assert.equal(parsed.id(), 5);
    assert.ok(identity.publicKey.verify(parsed.publicKey().serialize(), parsed.signature()));
  });

  it('provisioning envelopes open across implementations', () => {
    const msg = text('serialized ProvisionMessage');
    const ours = new libsignal.ProvisioningReceiver();
    assert.deepEqual(ours.decryptEnvelope(u8(encryptProvisionMessage(u8(ours.publicKey()), msg))), msg);
    ours.free();

    const theirs = RecvProvisionCiphertextState.generate();
    assert.deepEqual(u8(theirs.decryptEnvelope(u8(libsignal.provisioningEncrypt(u8(theirs.publicKey), msg)))), msg);
  });
});

describe('Interop: zkgroup', () => {
  it('group identifiers, blobs, and member ciphertexts match the official library', () => {
    const mk = randomBytes(32);
    const ours = deriveGroupV2Keys(mk);
    const theirs = zk.GroupSecretParams.deriveFromMasterKey(new zk.GroupMasterKey(u8(mk)));
    assert.deepEqual(ours.groupIdentifier, u8(theirs.getPublicParams().getGroupIdentifier().serialize()));
    assert.deepEqual(ours.secretParams, u8(theirs.serialize()));

    const cipher = new zk.ClientZkGroupCipher(theirs);
    assert.deepEqual(u8(cipher.decryptBlob(u8(libsignal.groupEncryptBlob(ours.secretParams, text('title'), 0)))), text('title'));
    assert.deepEqual(libsignal.groupDecryptBlob(ours.secretParams, u8(cipher.encryptBlob(text('desc')))), text('desc'));
    const member = cipher.encryptServiceId(official.Aci.fromUuid(ALICE));
    assert.equal(libsignal.groupDecryptServiceId(ours.secretParams, u8(member.serialize())), ALICE);
  });

  it('profile key versions, commitments, and access keys match', () => {
    const pk = randomBytes(32);
    const theirs = new zk.ProfileKey(u8(pk));
    const aci = official.Aci.fromUuid(ALICE);
    assert.equal(libsignal.profileKeyGetVersion(pk, ALICE), theirs.getProfileKeyVersion(aci).toString());
    assert.deepEqual(libsignal.profileKeyGetCommitment(pk, ALICE), u8(theirs.getCommitment(aci).serialize()));
    assert.deepEqual(libsignal.profileKeyDeriveAccessKey(pk), u8(theirs.deriveAccessKey()));
  });
});

describe('Known answers: Storage Service and profile cipher (Signal-Desktop formulas)', () => {
  it('derives storage, manifest, and item keys', () => {
    const mk = Uint8Array.from({ length: 32 }, (_, i) => i);
    const sk = deriveStorageServiceKey(mk);
    assert.equal(toHex(sk), 'd9fd23ee99c148ad879f62609297139e6a36f415b1ad779d23c687b1fa6d36d9');
    assert.equal(toHex(deriveStorageManifestKey(sk, 7n)), 'd728bafc43d9bd972c5dba170ecc2f2c53f000ab0d3478e7b265d2bf09f566ae');
    const key = new Uint8Array(16).fill(0xaa);
    assert.equal(toHex(deriveStorageItemKey(sk, key)), 'de153cf35f9e7f320b3fa632e7213c862a3f518e25ba246cd76df81735cf1b7a');
    assert.equal(toHex(deriveStorageItemKey(sk, key, new Uint8Array(32).fill(0x42))), '0ca2cec726ae6e7419330e9e642b3499e042a1e0118a88b0edc258ddb9fccce0');
  });

  it('decrypts a fixed profile name ciphertext', async () => {
    const name = await decryptProfileName(
      'IiIiIiIiIiIiIiIiVptuKqXP1TCLWq08SKbp1R+TzeJqgaxLUk8K6AnhZQNFf6sCU6j53k5Y7S3mWEk1s9KeYpVw1XNC3l4ZgH/D6cpym8OZ',
      new Uint8Array(32).fill(0x11)
    );
    assert.deepEqual(name, { givenName: 'Alice', familyName: 'Jones', fullName: 'Alice Jones' });
  });
});
