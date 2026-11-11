import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { padMessagePlaintext } from '../src/engine/crypto/primitives';
import { libsignal } from '../src/engine/protocol/libsignal';
import { CallMessage_Offer_Type, Envelope_Type } from '../src/engine/gen/SignalService_pb';
import {
  CIPHERTEXT_PREKEY,
  CIPHERTEXT_WHISPER,
  compareScannedSafetyNumber,
  decryptionErrorContent,
  decryptWhisper,
  encryptForDevice,
  errorCode,
  localIdentity,
  plaintextContentBody,
  safetyNumber,
} from '../src/engine/protocol/protocol';
import { ALICE, BOB, text } from './helpers';
import { connect, contentBytes, envelopeBytes, loadWasmForTests, newAccount } from './support';
import { decryptEnvelope, DecryptFailure } from '../src/engine/net/receive';

before(() => {
  assert.equal(loadWasmForTests(), '0.106.2');
});

describe('libsignal sessions (PQXDH + ratchet)', () => {
  it('builds a session from a server bundle and exchanges messages both ways, out of order', async () => {
    const alice = newAccount(ALICE, 2);
    const bob = newAccount(BOB, 1);
    const keys = await connect(alice, bob);
    const aliceLocal = await localIdentity(alice.store);
    const bobLocal = await localIdentity(bob.store);

    const first = await encryptForDevice(
      alice.store,
      aliceLocal,
      BOB,
      1,
      padMessagePlaintext(contentBytes({ content: { case: 'dataMessage', value: { body: 'hello', timestamp: 1700000000000n } } }))
    );
    assert.equal(first.envelopeType, 3);
    assert.equal(first.registrationId, keys.devices[0].registrationId);

    const env = envelopeBytes({
      type: Envelope_Type.PREKEY_MESSAGE,
      sourceServiceId: ALICE,
      sourceDeviceId: 2,
      clientTimestamp: 1700000000000n,
      content: first.body,
    });
    const res = await decryptEnvelope(bob.store, env);
    assert.ok(res);
    assert.equal(res.normalizedFrame.envelope.dataMessage.message, 'hello');
    assert.equal(res.normalizedFrame.envelope.sourceUuid, ALICE);

    // One-time EC and Kyber PreKeys were consumed; the last-resort Kyber key stays
    assert.equal(await bob.store.loadPreKey(keys.devices[0].preKey.keyId), null);
    assert.equal(await bob.store.loadKyberPreKey(keys.devices[0].pqPreKey.keyId), null);
    assert.ok(await bob.store.loadSignedPreKey(keys.devices[0].signedPreKey.keyId));

    const reply = await encryptForDevice(bob.store, bobLocal, ALICE, 2, text('reply'));
    assert.equal(reply.envelopeType, 1);
    assert.deepEqual((await decryptWhisper(alice.store, aliceLocal, BOB, 1, reply.body)).plaintext, text('reply'));

    const a = await encryptForDevice(alice.store, aliceLocal, BOB, 1, text('A'));
    const b = await encryptForDevice(alice.store, aliceLocal, BOB, 1, text('B'));
    assert.deepEqual((await decryptWhisper(bob.store, bobLocal, ALICE, 2, b.body)).plaintext, text('B'));
    assert.deepEqual((await decryptWhisper(bob.store, bobLocal, ALICE, 2, a.body)).plaintext, text('A'));

    await assert.rejects(decryptWhisper(bob.store, bobLocal, ALICE, 2, a.body), (e) => errorCode(e) === 'DuplicatedMessage');
  });

  it('flags the frame when a known contact arrives with a new identity key', async () => {
    const alice = newAccount(ALICE, 2);
    const bob = newAccount(BOB, 1);
    const old = libsignal.keyPairGenerate() as { publicKey: Uint8Array };
    await bob.store.saveIdentity(ALICE, old.publicKey, { uuid: ALICE });
    await connect(alice, bob);
    const msg = await encryptForDevice(
      alice.store,
      await localIdentity(alice.store),
      BOB,
      1,
      padMessagePlaintext(contentBytes({ content: { case: 'dataMessage', value: { body: 'new phone', timestamp: 1700000001000n } } }))
    );
    const res = await decryptEnvelope(
      bob.store,
      envelopeBytes({ type: Envelope_Type.PREKEY_MESSAGE, sourceServiceId: ALICE, sourceDeviceId: 2, clientTimestamp: 1700000001000n, content: msg.body })
    );
    assert.ok(res);
    assert.equal(res.normalizedFrame.envelope.safetyNumberChanged, true);
    assert.equal(res.normalizedFrame.envelope.dataMessage.message, 'new phone');
  });

  it('decrypts identified envelopes into normalized frames (calls, stickers, view-once)', async () => {
    const alice = newAccount(ALICE, 2);
    const bob = newAccount(BOB, 1);
    await connect(alice, bob);
    const aliceLocal = await localIdentity(alice.store);

    const call = await encryptForDevice(
      alice.store,
      aliceLocal,
      BOB,
      1,
      padMessagePlaintext(contentBytes({ content: { case: 'callMessage', value: { offer: { id: 999n, type: CallMessage_Offer_Type.OFFER_AUDIO_CALL } } } }))
    );
    const decCall = await decryptEnvelope(
      bob.store,
      envelopeBytes({ type: Envelope_Type.PREKEY_MESSAGE, sourceServiceId: ALICE, sourceDeviceId: 2, clientTimestamp: 1700000555000n, content: call.body })
    );
    assert.ok(decCall);
    assert.deepEqual(decCall.normalizedFrame.envelope.notice, { kind: 'missedCall', video: false, timestamp: 1700000555000 });
    assert.equal(decCall.normalizedFrame.envelope.dataMessage, undefined);

    const sticker = await encryptForDevice(
      alice.store,
      aliceLocal,
      BOB,
      1,
      padMessagePlaintext(
        contentBytes({
          content: {
            case: 'dataMessage',
            value: {
              timestamp: 1700000666000n,
              isViewOnce: true,
              sticker: {
                packId: new Uint8Array(16),
                packKey: new Uint8Array(32),
                stickerId: 1,
                emoji: '\u{1F389}',
                data: {
                  attachmentIdentifier: { case: 'cdnKey', value: 'sticker-cdn-key' },
                  cdnNumber: 2,
                  contentType: 'image/webp',
                  key: new Uint8Array(64),
                  size: 1024,
                },
              },
            },
          },
        })
      )
    );
    const decSticker = await decryptEnvelope(
      bob.store,
      envelopeBytes({ type: Envelope_Type.PREKEY_MESSAGE, sourceServiceId: ALICE, sourceDeviceId: 2, clientTimestamp: 1700000666000n, content: sticker.body })
    );
    assert.ok(decSticker);
    const dm = decSticker.normalizedFrame.envelope.dataMessage;
    assert.equal(dm.message, '\u{1F389}');
    assert.equal(dm.viewOnce, true);
    assert.equal(dm.attachments.length, 1);
  });

  it('reports undecryptable messages as DecryptFailure with what a retry receipt needs', async () => {
    const alice = newAccount(ALICE, 2);
    const bob = newAccount(BOB, 1);
    await connect(alice, bob);
    const msg = await encryptForDevice(alice.store, await localIdentity(alice.store), BOB, 1, text('x'));
    const tampered = new Uint8Array(msg.body);
    tampered[tampered.length - 1] ^= 0xff;

    await assert.rejects(
      decryptEnvelope(
        bob.store,
        envelopeBytes({ type: Envelope_Type.PREKEY_MESSAGE, sourceServiceId: ALICE, sourceDeviceId: 2, clientTimestamp: 42n, content: tampered })
      ),
      (e: unknown) => {
        assert.ok(e instanceof DecryptFailure);
        assert.equal(e.senderName, ALICE);
        assert.equal(e.senderDeviceId, 2);
        assert.equal(e.ciphertextType, CIPHERTEXT_PREKEY);
        assert.equal(e.timestamp, 42);
        return true;
      }
    );

    const retry = decryptionErrorContent(msg.body, CIPHERTEXT_PREKEY, 42, 2);
    assert.ok(plaintextContentBody(retry).length > 0);
    assert.notEqual(CIPHERTEXT_WHISPER, CIPHERTEXT_PREKEY);
  });

  it('refuses to send to a changed identity until it is saved, matching the trust policy', async () => {
    const alice = newAccount(ALICE, 2);
    const bob = newAccount(BOB, 1);
    await connect(alice, bob);
    const other = libsignal.keyPairGenerate() as { publicKey: Uint8Array };
    assert.equal(await alice.store.saveIdentity(BOB, other.publicKey), true);
    assert.equal((await alice.store.getIdentity(BOB))!.trustLevel, 'UNTRUSTED');
    await assert.rejects(
      encryptForDevice(alice.store, await localIdentity(alice.store), BOB, 1, text('x')),
      (e) => errorCode(e) === 'UntrustedIdentity'
    );
  });
});

describe('libsignal sender keys', () => {
  it('distributes a sender key and decrypts group messages out of order', async () => {
    const alice = newAccount(ALICE, 2);
    const bob = newAccount(BOB, 1);
    const dist = '33333333-3333-4333-8333-333333333333';
    const aliceLocal = await localIdentity(alice.store);
    const bobLocal = await localIdentity(bob.store);

    const ps = new libsignal.ProtocolStore(aliceLocal.keyPair.pubKey, aliceLocal.keyPair.privKey, aliceLocal.registrationId);
    const skdm = libsignal.createSenderKeyDistributionMessage(ps, ALICE, 2, dist);
    const m1 = libsignal.groupEncrypt(ps, ALICE, 2, dist, text('first'));
    const m2 = libsignal.groupEncrypt(ps, ALICE, 2, dist, text('second'));
    ps.free();

    const { decryptSenderKey, processSenderKeyDistribution } = await import('../src/engine/protocol/protocol');
    await processSenderKeyDistribution(bob.store, bobLocal, ALICE, 2, skdm);
    assert.ok(await bob.store.loadSenderKey(ALICE, 2, dist));
    assert.deepEqual(await decryptSenderKey(bob.store, bobLocal, ALICE, 2, m2), text('second'));
    assert.deepEqual(await decryptSenderKey(bob.store, bobLocal, ALICE, 2, m1), text('first'));
  });
});

describe('libsignal safety numbers', () => {
  it('computes symmetric 60-digit safety numbers and matches scanned QR codes', () => {
    const a = libsignal.keyPairGenerate() as { publicKey: Uint8Array };
    const b = libsignal.keyPairGenerate() as { publicKey: Uint8Array };
    const aliceView = safetyNumber(ALICE, a.publicKey, BOB, b.publicKey);
    const bobView = safetyNumber(BOB, b.publicKey, ALICE, a.publicKey);
    assert.equal(aliceView.safetyNumber.length, 60);
    assert.equal(aliceView.safetyNumber, bobView.safetyNumber);
    assert.equal(compareScannedSafetyNumber(aliceView.scannable, bobView.scannable), true);
    assert.equal(compareScannedSafetyNumber(aliceView.scannable, aliceView.scannable), false);
  });
});

describe('libsignal provisioning cipher', () => {
  it('round-trips a ProvisionEnvelope through the official cipher', () => {
    const receiver = new libsignal.ProvisioningReceiver();
    const message = text('provision-message-bytes');
    const envelope = libsignal.provisioningEncrypt(receiver.publicKey(), message);
    assert.deepEqual(receiver.decryptEnvelope(envelope), message);
    const tampered = new Uint8Array(envelope);
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(() => receiver.decryptEnvelope(tampered));
    receiver.free();
  });
});
