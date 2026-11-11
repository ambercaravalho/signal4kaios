/* A number change made on the primary phone, ported from Signal-Desktop's `MessageReceiver #handlePNIChangeNumber`, `AccountManager.setPni`, and `SignalProtocolStore.updateOurPniKeyMaterial`: the phone sends each linked device its new PNI identity, signed PreKey, last-resort Kyber PreKey, and registration ID, and the new PNI rides on the envelope. Key records are parsed by libsignal. */

import type { SyncMessage_PniChangeNumber } from '../gen/SignalService_pb';
import type { IncomingEnvelope } from '../net/receive';
import { libsignal } from '../protocol/libsignal';
import { skipPreKeyIds } from '../protocol/prekeys';
import type { SignalProtocolStore } from '../protocol/store';
import { E164_RE } from '../validate';

export interface NumberChange {
  number: string;
  pni: string;
  oldNumber: string;
}

/** Apply a `pniChangeNumber` sync; null when it's incomplete (Desktop ignores those too). Throws when it isn't from our own account. */
export async function applyPniChangeNumber(store: SignalProtocolStore, env: IncomingEnvelope, change: SyncMessage_PniChangeNumber): Promise<NumberChange | null> {
  const acc = await store.getAccount();
  if (!acc || env.sourceUuid !== acc.aci) throw new Error('Received a number change from another account');
  const pni = env.updatedPni;
  if (!pni) return null;
  if (!change.identityKeyPair.length || !change.signedPreKey.length || !(change.registrationId > 0) || !E164_RE.test(change.newE164 || '')) return null;

  // SECURITY-REVIEW: the new PNI identity private key comes from our primary phone inside an end-to-end encrypted sync message and is kept only in the protocol store.
  const pair = libsignal.identityKeyPairDeserialize(change.identityKeyPair) as { publicKey: Uint8Array; privateKey: Uint8Array };
  const signedPreKeyId = libsignal.signedPreKeyRecordId(change.signedPreKey);
  const kyberPreKeyId = change.lastResortKyberPreKey.length ? libsignal.kyberPreKeyRecordId(change.lastResortKyberPreKey) : undefined;

  await store.storeSignedPreKey(signedPreKeyId, change.signedPreKey);
  if (kyberPreKeyId !== undefined) await store.storeKyberPreKey(kyberPreKeyId, change.lastResortKyberPreKey, true);
  await skipPreKeyIds(store, 'pni', { signedPreKey: signedPreKeyId, kyberPreKey: kyberPreKeyId });

  if (acc.pni && acc.pni !== pni) await store.removeIdentity('PNI:' + acc.pni);
  await store.saveIdentity('PNI:' + pni, pair.publicKey);
  await store.saveAccount({
    ...acc,
    pni,
    number: change.newE164,
    pniRegistrationId: change.registrationId,
    pniIdentityKeyPair: { pubKey: pair.publicKey, privKey: pair.privateKey },
  });
  await store.storeValue('groupCredentials', []);
  return { number: change.newE164, pni, oldNumber: acc.number };
}
