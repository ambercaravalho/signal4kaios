/* PreKey generation via libsignal, persisted as libsignal records, with upload payloads shaped like Signal-Desktop's `PUT /v2/keys` and `PUT /v1/devices/link` bodies. */

import { toBase64 } from '../bytes';
import { libsignal } from './libsignal';
import type { KeyPair, SignalProtocolStore } from './store';

/** Signal's PreKey IDs are 24-bit (Signal-Desktop `MAX_PRE_KEY_ID`). */
const MAX_PRE_KEY_ID = 0xffffff;

export const ONE_TIME_PRE_KEY_COUNT = 100;

export interface UploadPreKey {
  keyId: number;
  publicKey: string;
}

export interface UploadSignedPreKey extends UploadPreKey {
  signature: string;
}

export interface PreKeyUpload {
  preKeys?: UploadPreKey[];
  pqPreKeys?: UploadSignedPreKey[];
  signedPreKey?: UploadSignedPreKey;
  pqLastResortPreKey?: UploadSignedPreKey;
}

interface IdCounters {
  preKey: number;
  signedPreKey: number;
  kyberPreKey: number;
}

function randomStartId(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] % (MAX_PRE_KEY_ID - 1)) + 1;
}

function nextId(id: number): number {
  return id >= MAX_PRE_KEY_ID ? 1 : id + 1;
}

/** Allocates `count` consecutive IDs of one kind for one identity, persisting the counter so IDs are never reused. */
async function allocateIds(
  store: SignalProtocolStore,
  identity: 'aci' | 'pni',
  kind: keyof IdCounters,
  count: number
): Promise<number[]> {
  const key = 'preKeyIds:' + identity;
  const counters: IdCounters = (await store.loadValue<IdCounters>(key)) || {
    preKey: randomStartId(),
    signedPreKey: randomStartId(),
    kyberPreKey: randomStartId(),
  };
  const ids: number[] = [];
  let id = counters[kind];
  for (let i = 0; i < count; i++) {
    ids.push(id);
    id = nextId(id);
  }
  counters[kind] = id;
  await store.storeValue(key, counters);
  return ids;
}

export async function generateSignedPreKey(
  store: SignalProtocolStore,
  identity: 'aci' | 'pni',
  identityKeyPair: KeyPair,
  now = Date.now()
): Promise<UploadSignedPreKey> {
  const [keyId] = await allocateIds(store, identity, 'signedPreKey', 1);
  const gen = libsignal.signedPreKeyRecordGenerate(keyId, now, identityKeyPair.privKey) as {
    record: Uint8Array;
    publicKey: Uint8Array;
    signature: Uint8Array;
  };
  await store.storeSignedPreKey(keyId, gen.record);
  return { keyId, publicKey: toBase64(gen.publicKey), signature: toBase64(gen.signature) };
}

export async function generateKyberPreKeys(
  store: SignalProtocolStore,
  identity: 'aci' | 'pni',
  identityKeyPair: KeyPair,
  count: number,
  lastResort: boolean,
  now = Date.now()
): Promise<UploadSignedPreKey[]> {
  const ids = await allocateIds(store, identity, 'kyberPreKey', count);
  const out: UploadSignedPreKey[] = [];
  for (const keyId of ids) {
    const gen = libsignal.kyberPreKeyRecordGenerate(keyId, now, identityKeyPair.privKey) as {
      record: Uint8Array;
      publicKey: Uint8Array;
      signature: Uint8Array;
    };
    await store.storeKyberPreKey(keyId, gen.record, lastResort);
    out.push({ keyId, publicKey: toBase64(gen.publicKey), signature: toBase64(gen.signature) });
  }
  return out;
}

export async function generateOneTimePreKeys(
  store: SignalProtocolStore,
  identity: 'aci' | 'pni',
  count: number
): Promise<UploadPreKey[]> {
  const ids = await allocateIds(store, identity, 'preKey', count);
  const out: UploadPreKey[] = [];
  for (const keyId of ids) {
    const gen = libsignal.preKeyRecordGenerate(keyId) as { record: Uint8Array; publicKey: Uint8Array };
    await store.storePreKey(keyId, gen.record);
    out.push({ keyId, publicKey: toBase64(gen.publicKey) });
  }
  return out;
}

/** A full `PUT /v2/keys?identity=...` body: fresh signed and last-resort Kyber PreKeys plus one-time EC and Kyber PreKeys. */
export async function generatePreKeyUpload(
  store: SignalProtocolStore,
  identity: 'aci' | 'pni',
  identityKeyPair: KeyPair,
  oneTimeCount = ONE_TIME_PRE_KEY_COUNT
): Promise<Required<PreKeyUpload>> {
  return {
    signedPreKey: await generateSignedPreKey(store, identity, identityKeyPair),
    pqLastResortPreKey: (await generateKyberPreKeys(store, identity, identityKeyPair, 1, true))[0],
    preKeys: await generateOneTimePreKeys(store, identity, oneTimeCount),
    pqPreKeys: await generateKyberPreKeys(store, identity, identityKeyPair, oneTimeCount, false),
  };
}
