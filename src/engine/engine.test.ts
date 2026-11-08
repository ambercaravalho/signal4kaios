import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateAgreement,
  calculateSignature,
  generateKeyPair,
  verifySignature,
} from './crypto/curve';
import {
  decryptAttachment,
  decryptProfileField,
  encryptAttachment,
  encryptProfileField,
} from './crypto/attachment';
import {
  padMessagePlaintext,
  unpadMessagePlaintext,
} from './crypto/primitives';
import {
  decryptPreKeyWhisperMessage,
  decryptWhisperMessage,
  encryptWhisperMessage,
  initSessionFromPreKeyBundle,
} from './protocol/session';
import {
  sealSenderMessage,
  unsealSenderMessage,
} from './protocol/sealed-sender';
import {
  createSenderKeyDistributionMessage,
  decryptSenderKeyMessage,
  encryptSenderKeyMessage,
  processSenderKeyDistributionMessage,
} from './protocol/sender-keys';
import {
  generateSafetyNumber,
  verifyScannedSafetyNumber,
} from './protocol/fingerprint';
import {
  decryptProvisionEnvelope,
  encryptProvisionEnvelope,
  generateAndStorePreKeyBundle,
} from './provisioning';
import {
  decodeEnvelope,
  encodeContent,
  encodeEnvelope,
  encodeSenderCertificate,
  EnvelopeType,
  ProtoWriter,
} from './proto';
import { decryptEnvelope } from './transport';
import { MemorySignalStore } from './storage';
import { fromBase64, randomBytes } from './bytes';

describe('Signal Curve25519 & XEdDSA', () => {
  it('computes symmetric ECDH shared secrets and verifies XEdDSA signatures', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();

    const s1 = calculateAgreement(bob.pubKey, alice.privKey);
    const s2 = calculateAgreement(alice.pubKey, bob.privKey);
    assert.deepEqual(s1, s2);

    const msg = new TextEncoder().encode('Signal4KaiOS v2.0.0 XEdDSA test');
    const sig = calculateSignature(alice.privKey, msg);
    assert.equal(sig.length, 64);
    assert.equal(verifySignature(alice.pubKey, msg, sig), true);

    const tampered = new Uint8Array(msg);
    tampered[0] ^= 0xff;
    assert.equal(verifySignature(alice.pubKey, tampered, sig), false);
    assert.equal(verifySignature(bob.pubKey, msg, sig), false);
  });
});

describe('Signal X3DH & Double Ratchet Session', () => {
  it('establishes a session from a PreKeyBundle and exchanges bidirectional messages', async () => {
    const aliceIdentity = generateKeyPair();
    const bobIdentity = generateKeyPair();

    const aliceStore = new MemorySignalStore({
      aci: '11111111-1111-1111-1111-111111111111',
      number: '+15550001111',
      deviceId: 2,
      password: 'alice-password',
      registrationId: 1001,
      pniRegistrationId: 1002,
      aciIdentityKeyPair: aliceIdentity,
    });

    const bobStore = new MemorySignalStore({
      aci: '22222222-2222-2222-2222-222222222222',
      number: '+15550002222',
      deviceId: 1,
      password: 'bob-password',
      registrationId: 2001,
      pniRegistrationId: 2002,
      aciIdentityKeyPair: bobIdentity,
    });

    const bobBundle = await generateAndStorePreKeyBundle(bobStore, bobIdentity, 7, 100, 5);
    const bobSpk = await bobStore.loadSignedPreKey(7);
    const bobOpk = await bobStore.loadPreKey(100);
    assert.ok(bobSpk);
    assert.ok(bobOpk);

    await initSessionFromPreKeyBundle(aliceStore, '22222222-2222-2222-2222-222222222222.1', {
      registrationId: 2001,
      deviceId: 1,
      preKeyId: 100,
      preKeyPublic: fromBase64(bobBundle.preKeys[0].publicKey),
      signedPreKeyId: 7,
      signedPreKeyPublic: fromBase64(bobBundle.signedPreKey.publicKey),
      signedPreKeySignature: fromBase64(bobBundle.signedPreKey.signature),
      identityKey: fromBase64(bobBundle.identityKey),
    });

    // Alice sends first PreKeySignalMessage to Bob
    const plain1 = new TextEncoder().encode('Hello Bob from KaiOS 3.0!');
    const enc1 = await encryptWhisperMessage(
      aliceStore,
      '22222222-2222-2222-2222-222222222222.1',
      plain1
    );
    assert.equal(enc1.type, 3);

    const dec1 = await decryptPreKeyWhisperMessage(
      bobStore,
      '11111111-1111-1111-1111-111111111111.2',
      enc1.body
    );
    assert.deepEqual(dec1, plain1);

    // One-time PreKey 100 was consumed on Bob's store
    assert.equal(await bobStore.loadPreKey(100), null);

    // Bob replies to Alice (standard WhisperMessage type 1)
    const plain2 = new TextEncoder().encode('Reply from Bob');
    const enc2 = await encryptWhisperMessage(
      bobStore,
      '11111111-1111-1111-1111-111111111111.2',
      plain2
    );
    assert.equal(enc2.type, 1);

    const dec2 = await decryptWhisperMessage(
      aliceStore,
      '22222222-2222-2222-2222-222222222222.1',
      enc2.body
    );
    assert.deepEqual(dec2, plain2);

    // Out-of-order messages from Alice to Bob
    const msgA = new TextEncoder().encode('Message A');
    const msgB = new TextEncoder().encode('Message B');
    const encA = await encryptWhisperMessage(
      aliceStore,
      '22222222-2222-2222-2222-222222222222.1',
      msgA
    );
    const encB = await encryptWhisperMessage(
      aliceStore,
      '22222222-2222-2222-2222-222222222222.1',
      msgB
    );
    assert.equal(encA.type, 1);
    assert.equal(encB.type, 1);

    // Bob receives B before A
    const decB = await decryptWhisperMessage(
      bobStore,
      '11111111-1111-1111-1111-111111111111.2',
      encB.body
    );
    const decA = await decryptWhisperMessage(
      bobStore,
      '11111111-1111-1111-1111-111111111111.2',
      encA.body
    );
    assert.deepEqual(decB, msgB);
    assert.deepEqual(decA, msgA);
  });
});

describe('Sealed Sender & Envelope Pipeline', () => {
  it('seals and unseals an UnidentifiedSenderMessage and normalizes DataMessage', async () => {
    const aliceIdentity = generateKeyPair();
    const bobIdentity = generateKeyPair();

    const aliceUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const bobUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    const aliceStore = new MemorySignalStore({
      aci: aliceUuid,
      number: '+15551110000',
      deviceId: 2,
      password: 'pw',
      registrationId: 111,
      pniRegistrationId: 112,
      aciIdentityKeyPair: aliceIdentity,
    });

    const bobStore = new MemorySignalStore({
      aci: bobUuid,
      number: '+15552220000',
      deviceId: 1,
      password: 'pw',
      registrationId: 222,
      pniRegistrationId: 223,
      aciIdentityKeyPair: bobIdentity,
    });

    const bobBundle = await generateAndStorePreKeyBundle(bobStore, bobIdentity, 1, 1, 2);
    await initSessionFromPreKeyBundle(aliceStore, `${bobUuid}.1`, {
      registrationId: 222,
      deviceId: 1,
      preKeyId: 1,
      preKeyPublic: fromBase64(bobBundle.preKeys[0].publicKey),
      signedPreKeyId: 1,
      signedPreKeyPublic: fromBase64(bobBundle.signedPreKey.publicKey),
      signedPreKeySignature: fromBase64(bobBundle.signedPreKey.signature),
      identityKey: fromBase64(bobBundle.identityKey),
    });

    // Build a SenderCertificate for Alice
    const certDetails = new ProtoWriter()
      .writeString(1, '+15551110000')
      .writeUint32(2, 2)
      .writeFixed64(3, Date.now() + 86400000)
      .writeBytes(4, aliceIdentity.pubKey)
      .writeString(6, aliceUuid)
      .finish();

    const senderCert = {
      certificate: certDetails,
      signature: randomBytes(64),
    };

    const contentBytes = padMessagePlaintext(
      encodeContent({
        dataMessage: {
          body: 'Sealed hello!',
          timestamp: 1700000000000,
          expireTimer: 60,
        },
      })
    );

    const sealedBytes = await sealSenderMessage(
      aliceStore,
      `${bobUuid}.1`,
      senderCert,
      contentBytes
    );

    const envBytes = encodeEnvelope({
      type: EnvelopeType.UNIDENTIFIED_SENDER,
      timestamp: 1700000000000,
      content: sealedBytes,
    });

    const result = await decryptEnvelope(bobStore, envBytes);
    assert.ok(result);
    assert.equal(result.envelope.sourceUuid, aliceUuid);
    assert.equal(result.envelope.sourceE164, '+15551110000');
    assert.equal(result.normalizedFrame.envelope.dataMessage.message, 'Sealed hello!');
    assert.equal(result.normalizedFrame.envelope.dataMessage.expiresInSeconds, 60);
  });
});

describe('Group Sender Keys', () => {
  it('distributes a SenderKey and encrypts/decrypts group messages including out-of-order iterations', async () => {
    const aliceStore = new MemorySignalStore();
    const bobStore = new MemorySignalStore();
    const groupSenderKeyId = 'group-1::alice.2';

    const skdm = await createSenderKeyDistributionMessage(aliceStore, groupSenderKeyId);
    await processSenderKeyDistributionMessage(bobStore, groupSenderKeyId, skdm);

    const plain1 = new TextEncoder().encode('First group message');
    const plain2 = new TextEncoder().encode('Second group message');

    const cipher1 = await encryptSenderKeyMessage(aliceStore, groupSenderKeyId, plain1);
    const cipher2 = await encryptSenderKeyMessage(aliceStore, groupSenderKeyId, plain2);

    // Bob decrypts 2 then 1
    const dec2 = await decryptSenderKeyMessage(bobStore, groupSenderKeyId, cipher2);
    const dec1 = await decryptSenderKeyMessage(bobStore, groupSenderKeyId, cipher1);

    assert.deepEqual(dec2, plain2);
    assert.deepEqual(dec1, plain1);
  });
});

describe('Provisioning Cipher & Attachment Crypto & Safety Numbers', () => {
  it('encrypts and decrypts a ProvisionEnvelope for Linked Device QR setup', async () => {
    const kaiosEphemeral = generateKeyPair();
    const primaryIdentity = generateKeyPair();

    const envBytes = await encryptProvisionEnvelope(
      {
        aci: '12345678-1234-4234-8234-123456789abc',
        number: '+15559998888',
        provisioningCode: 'prov-code-123',
        aciIdentityKeyPublic: primaryIdentity.pubKey,
        aciIdentityKeyPrivate: primaryIdentity.privKey,
        profileKey: randomBytes(32),
      },
      kaiosEphemeral.pubKey
    );

    const decrypted = await decryptProvisionEnvelope(envBytes, kaiosEphemeral);
    assert.equal(decrypted.aci, '12345678-1234-4234-8234-123456789abc');
    assert.equal(decrypted.number, '+15559998888');
    assert.equal(decrypted.provisioningCode, 'prov-code-123');
    assert.deepEqual(decrypted.aciIdentityKeyPrivate, primaryIdentity.privKey);
  });

  it('encrypts and decrypts Signal CDN attachments and profile fields', async () => {
    const original = new TextEncoder().encode('Attachment binary content on KaiOS');
    const enc = await encryptAttachment(original);
    const dec = await decryptAttachment(enc.ciphertext, enc.key, enc.digest);
    assert.deepEqual(dec, original);

    const profileKey = randomBytes(32);
    const nameBytes = new TextEncoder().encode('Alice');
    const encProf = await encryptProfileField(nameBytes, profileKey);
    const decProf = await decryptProfileField(encProf, profileKey);
    assert.deepEqual(decProf, nameBytes);
  });

  it('computes symmetric 60-digit safety numbers and verifies QR fingerprints', () => {
    const aliceKey = generateKeyPair().pubKey;
    const bobKey = generateKeyPair().pubKey;
    const aliceUuid = '11111111-1111-4111-8111-111111111111';
    const bobUuid = '22222222-2222-4222-8222-222222222222';

    const aliceView = generateSafetyNumber(aliceUuid, aliceKey, bobUuid, bobKey);
    const bobView = generateSafetyNumber(bobUuid, bobKey, aliceUuid, aliceKey);

    assert.equal(aliceView.safetyNumber.length, 60);
    assert.equal(aliceView.safetyNumber, bobView.safetyNumber);
    assert.equal(verifyScannedSafetyNumber(bobView.scannableQrBytes, aliceView), true);
  });
});
