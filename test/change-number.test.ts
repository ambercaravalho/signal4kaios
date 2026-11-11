import './ui-env';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as official from '@signalapp/libsignal-client';

import { toBase64, uuidToBytes } from '../src/engine/bytes';
import { padMessagePlaintext } from '../src/engine/crypto/primitives';
import { Envelope_Type, SyncMessage_PniChangeNumberSchema } from '../src/engine/gen/SignalService_pb';
import { create } from '../src/engine/net/proto';
import { decryptEnvelope, IncomingEnvelope, updatedPniFrom } from '../src/engine/net/receive';
import { generateSignedPreKey } from '../src/engine/protocol/prekeys';
import { encryptForDevice, localIdentity, parsePreKeyResponse, processPreKeyBundle } from '../src/engine/protocol/protocol';
import { libsignal } from '../src/engine/protocol/libsignal';
import { applyPniChangeNumber } from '../src/engine/services/change-number';
import { config } from '../src/ui/data/config';
import { db } from '../src/ui/data/db';
import { contentBytes, envelopeBytes, loadWasmForTests, newAccount } from './support';

const ME = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const OLD_PNI = '33333333-3333-4333-8333-333333333333';
const NEW_PNI = '44444444-4444-4444-8444-444444444444';
const OLD_NUMBER = '+15550001111';
const NEW_NUMBER = '+15550002222';

before(() => {
  loadWasmForTests();
});

async function linkedPhone() {
  const me = newAccount(ME, 2, OLD_NUMBER);
  const acc = (await me.store.getAccount())!;
  const oldPni = libsignal.keyPairGenerate() as { publicKey: Uint8Array; privateKey: Uint8Array };
  await me.store.saveAccount({ ...acc, pni: OLD_PNI, pniIdentityKeyPair: { pubKey: oldPni.publicKey, privKey: oldPni.privateKey } });
  await me.store.saveIdentity('PNI:' + OLD_PNI, oldPni.publicKey);
  await me.store.storeValue('groupCredentials', [{ redemptionTime: 1, credential: 'AA==' }]);
  return me;
}

/** What the primary phone sends this device: a new PNI identity with a signed PreKey and last-resort Kyber PreKey, made by the official library. */
function primaryKeyMaterial() {
  const identity = official.IdentityKeyPair.generate();
  const spk = official.PrivateKey.generate();
  const spkSig = identity.privateKey.sign(spk.getPublicKey().serialize());
  const signed = official.SignedPreKeyRecord.new(77, Date.now(), spk.getPublicKey(), spk, spkSig);
  const kem = official.KEMKeyPair.generate();
  const kemSig = identity.privateKey.sign(kem.getPublicKey().serialize());
  const kyber = official.KyberPreKeyRecord.new(88, Date.now(), kem, kemSig);
  const change = create(SyncMessage_PniChangeNumberSchema, {
    identityKeyPair: identity.serialize(),
    signedPreKey: signed.serialize(),
    lastResortKyberPreKey: kyber.serialize(),
    registrationId: 1234,
    newE164: NEW_NUMBER,
  });
  const bundle = {
    identityKey: toBase64(identity.publicKey.serialize()),
    devices: [
      {
        deviceId: 2,
        registrationId: 1234,
        signedPreKey: { keyId: 77, publicKey: toBase64(spk.getPublicKey().serialize()), signature: toBase64(spkSig) },
        pqPreKey: { keyId: 88, publicKey: toBase64(kem.getPublicKey().serialize()), signature: toBase64(kemSig) },
      },
    ],
  };
  return { identity, change, bundle };
}

function syncEnvelope(over: Partial<IncomingEnvelope> = {}): IncomingEnvelope {
  return { type: Envelope_Type.UNIDENTIFIED_SENDER, sourceUuid: ME, sourceDevice: 1, destinationServiceId: ME, timestamp: 1, serverTimestamp: 1, serverGuid: '', updatedPni: NEW_PNI, ...over };
}

describe('number change from the primary phone', () => {
  it('reads the new PNI from the envelope, raw or as a string', () => {
    assert.equal(updatedPniFrom('', uuidToBytes(NEW_PNI)), NEW_PNI);
    assert.equal(updatedPniFrom('PNI:' + NEW_PNI.toUpperCase(), undefined), NEW_PNI);
    assert.equal(updatedPniFrom(NEW_PNI, new Uint8Array(0)), NEW_PNI);
    assert.equal(updatedPniFrom('', new Uint8Array(0)), undefined);
    assert.equal(updatedPniFrom('not-a-uuid', undefined), undefined);
  });

  it('takes on the new PNI keys and number, and a message to the new PNI decrypts', async () => {
    const me = await linkedPhone();
    const { identity, change, bundle } = primaryKeyMaterial();
    const res = await applyPniChangeNumber(me.store, syncEnvelope(), change);
    assert.deepEqual(res, { number: NEW_NUMBER, pni: NEW_PNI, oldNumber: OLD_NUMBER });

    const acc = (await me.store.getAccount())!;
    assert.equal(acc.pni, NEW_PNI);
    assert.equal(acc.number, NEW_NUMBER);
    assert.equal(acc.pniRegistrationId, 1234);
    assert.deepEqual(acc.pniIdentityKeyPair!.pubKey, new Uint8Array(identity.publicKey.serialize()));
    assert.equal(acc.aci, ME, 'the account itself is unchanged');
    assert.equal(await me.store.getIdentity('PNI:' + OLD_PNI), null, 'the old PNI identity is dropped');
    assert.ok(await me.store.getIdentity('PNI:' + NEW_PNI));
    assert.ok(await me.store.loadSignedPreKey(77));
    assert.deepEqual(await me.store.loadKyberPreKey(88).then((k) => k && k.lastResort), true);
    assert.deepEqual(await me.store.loadValue('groupCredentials'), [], 'group credentials for the old PNI are cleared');
    const next = await generateSignedPreKey(me.store, 'pni', acc.pniIdentityKeyPair!);
    assert.equal(next.keyId, 78, 'our next signed PreKey ID follows the primary’s');

    const bob = newAccount(BOB, 1);
    const [b] = parsePreKeyResponse(bundle);
    const bobLocal = await localIdentity(bob.store);
    await processPreKeyBundle(bob.store, bobLocal, 'PNI:' + NEW_PNI, b);
    const msg = await encryptForDevice(bob.store, bobLocal, 'PNI:' + NEW_PNI, 2, padMessagePlaintext(contentBytes({ content: { case: 'dataMessage', value: { body: 'to your new number', timestamp: 1700000000000n } } })));
    const out = await decryptEnvelope(
      me.store,
      envelopeBytes({ type: Envelope_Type.PREKEY_MESSAGE, sourceServiceId: BOB, sourceDeviceId: 1, destinationServiceId: 'PNI:' + NEW_PNI, clientTimestamp: 1700000000000n, content: msg.body })
    );
    assert.ok(out);
    assert.equal(out.normalizedFrame.envelope.dataMessage.message, 'to your new number');
  });

  it('refuses a change from anyone else, and ignores one without a new PNI', async () => {
    const me = await linkedPhone();
    const { change } = primaryKeyMaterial();
    await assert.rejects(applyPniChangeNumber(me.store, syncEnvelope({ sourceUuid: BOB }), change), /another account/);
    assert.equal(await applyPniChangeNumber(me.store, syncEnvelope({ updatedPni: undefined }), change), null);
    assert.equal(await applyPniChangeNumber(me.store, syncEnvelope(), create(SyncMessage_PniChangeNumberSchema, { ...change, newE164: 'nope' })), null);
    assert.equal(await applyPniChangeNumber(me.store, syncEnvelope(), create(SyncMessage_PniChangeNumberSchema, { ...change, signedPreKey: new Uint8Array(0) })), null);
    const acc = (await me.store.getAccount())!;
    assert.equal(acc.pni, OLD_PNI);
    assert.equal(acc.number, OLD_NUMBER);
    assert.equal(await me.store.loadSignedPreKey(77), null);
  });

  it('keeps the database named after the number it was created under', () => {
    config.clear();
    config.set({ number: OLD_NUMBER, dbNumber: OLD_NUMBER, aci: ME, deviceId: 2, deviceToken: 't' });
    config.saveActiveAccount();
    config.set({ number: '+15559990000', dbNumber: '+15559990000', aci: BOB, deviceId: 3, deviceToken: 'u' });
    config.saveActiveAccount();
    config.switchAccount(OLD_NUMBER);
    const before = db.name();
    assert.equal(before, 'signal4kaios:' + OLD_NUMBER);

    config.changeNumber(NEW_NUMBER);
    assert.equal(config.number(), NEW_NUMBER);
    assert.equal(config.dbNumber(), OLD_NUMBER);
    assert.equal(db.name(), before);
    const saved = config.accounts().find((a) => a.aci === ME)!;
    assert.equal(saved.number, NEW_NUMBER);
    assert.equal(saved.dbNumber, OLD_NUMBER);
    assert.equal(config.accounts().length, 2);

    config.switchAccount('+15559990000');
    assert.equal(db.name(), 'signal4kaios:+15559990000');
    config.switchAccount(NEW_NUMBER);
    assert.equal(db.name(), before, 'switching back opens the same database');
    config.clear();
  });
});
