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

/** Move `identity`'s counters past PreKey IDs another device chose for us (Signal-Desktop `updateOurPniKeyMaterial`), so ours don't reuse them. */
export async function skipPreKeyIds(store: SignalProtocolStore, identity: 'aci' | 'pni', used: { signedPreKey?: number; kyberPreKey?: number }): Promise<void> {
  const key = 'preKeyIds:' + identity;
  const counters: IdCounters = (await store.loadValue<IdCounters>(key)) || { preKey: randomStartId(), signedPreKey: randomStartId(), kyberPreKey: randomStartId() };
  if (used.signedPreKey !== undefined) counters.signedPreKey = nextId(used.signedPreKey);
  if (used.kyberPreKey !== undefined) counters.kyberPreKey = nextId(used.kyberPreKey);
  await store.storeValue(key, counters);
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

/** The signed and last-resort Kyber PreKeys of a `PUT /v2/keys?identity=...` body. */
export async function generateRotationUpload(
  store: SignalProtocolStore,
  identity: 'aci' | 'pni',
  identityKeyPair: KeyPair,
  now = Date.now()
): Promise<{ signedPreKey: UploadSignedPreKey; pqLastResortPreKey: UploadSignedPreKey }> {
  return {
    signedPreKey: await generateSignedPreKey(store, identity, identityKeyPair, now),
    pqLastResortPreKey: (await generateKyberPreKeys(store, identity, identityKeyPair, 1, true, now))[0],
  };
}

/** The one-time EC and/or Kyber PreKeys of a `PUT /v2/keys?identity=...` body. */
export async function generateOneTimeUpload(
  store: SignalProtocolStore,
  identity: 'aci' | 'pni',
  identityKeyPair: KeyPair,
  which: { ec: boolean; kyber: boolean },
  count = ONE_TIME_PRE_KEY_COUNT
): Promise<PreKeyUpload> {
  const out: PreKeyUpload = {};
  if (which.ec) out.preKeys = await generateOneTimePreKeys(store, identity, count);
  if (which.kyber) out.pqPreKeys = await generateKyberPreKeys(store, identity, identityKeyPair, count, false);
  return out;
}

/** A full `PUT /v2/keys?identity=...` body: fresh signed and last-resort Kyber PreKeys plus one-time EC and Kyber PreKeys. */
export async function generatePreKeyUpload(
  store: SignalProtocolStore,
  identity: 'aci' | 'pni',
  identityKeyPair: KeyPair,
  oneTimeCount = ONE_TIME_PRE_KEY_COUNT
): Promise<Required<PreKeyUpload>> {
  const rotation = await generateRotationUpload(store, identity, identityKeyPair);
  const oneTime = await generateOneTimeUpload(store, identity, identityKeyPair, { ec: true, kyber: true }, oneTimeCount);
  return { ...rotation, preKeys: oneTime.preKeys!, pqPreKeys: oneTime.pqPreKeys! };
}

/* ---- Upkeep, after Signal-Desktop's maybeUpdateKeys ---- */

const DAY_MS = 24 * 60 * 60 * 1000;
/** The server's one-time key count below which a new batch is uploaded. */
export const MIN_ONE_TIME_PRE_KEYS = 10;
export const PRE_KEY_ROTATION_MS = 2 * DAY_MS;
const KEEP_ROTATED_PRE_KEYS = 3;
const ROTATED_PRE_KEY_MAX_AGE_MS = 30 * DAY_MS;

interface RotatedKey {
  id: number;
  at: number;
}

/** Signed and last-resort Kyber PreKeys we uploaded, newest last; `rotatedAt` is the last upload the server accepted. */
export interface PreKeyRotation {
  rotatedAt: number;
  signed: RotatedKey[];
  lastResort: RotatedKey[];
}

export async function loadPreKeyRotation(store: SignalProtocolStore, identity: 'aci' | 'pni'): Promise<PreKeyRotation> {
  const raw = await store.loadValue<PreKeyRotation>('preKeyRotation:' + identity);
  return {
    rotatedAt: (raw && Number(raw.rotatedAt)) || 0,
    signed: (raw && Array.isArray(raw.signed) && raw.signed) || [],
    lastResort: (raw && Array.isArray(raw.lastResort) && raw.lastResort) || [],
  };
}

export function rotationDue(rotation: PreKeyRotation, now = Date.now()): boolean {
  return now - rotation.rotatedAt >= PRE_KEY_ROTATION_MS;
}

/** Deletes the given key set's entries beyond the newest few that are also older than the age limit; returns the kept ones. */
async function prune(keys: RotatedKey[], now: number, remove: (id: number) => Promise<void>): Promise<RotatedKey[]> {
  const sorted = keys.slice().sort((a, b) => a.at - b.at);
  const kept: RotatedKey[] = [];
  sorted.forEach((k, i) => {
    if (i < sorted.length - KEEP_ROTATED_PRE_KEYS && now - k.at > ROTATED_PRE_KEY_MAX_AGE_MS) return;
    kept.push(k);
  });
  for (const k of sorted) if (kept.indexOf(k) < 0) await remove(k.id);
  return kept;
}

/** Records a signed and last-resort pair the server accepted, then prunes the old ones; only call this after a successful upload, so the newest key is always live. */
export async function recordPreKeyRotation(
  store: SignalProtocolStore,
  identity: 'aci' | 'pni',
  uploaded: { signedPreKey: { keyId: number }; pqLastResortPreKey: { keyId: number } },
  now = Date.now()
): Promise<void> {
  const rotation = await loadPreKeyRotation(store, identity);
  rotation.signed.push({ id: uploaded.signedPreKey.keyId, at: now });
  rotation.lastResort.push({ id: uploaded.pqLastResortPreKey.keyId, at: now });
  rotation.signed = await prune(rotation.signed, now, (id) => store.removeSignedPreKey(id));
  rotation.lastResort = await prune(rotation.lastResort, now, (id) => store.removeKyberPreKey(id));
  rotation.rotatedAt = now;
  await store.storeValue('preKeyRotation:' + identity, rotation);
}
