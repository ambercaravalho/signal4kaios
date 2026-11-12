/* An in-memory storage.signal.org and account store for the Storage Service tests. */

import assert from 'node:assert/strict';

import { concatBytes, randomBytes, toBase64 } from '../src/engine/bytes';
import { aesGcmEncrypt } from '../src/engine/crypto/primitives';
import {
  ContactRecordSchema,
  ManifestRecord_Identifier_Type,
  ManifestRecordSchema,
  ReadOperationSchema,
  StorageItemsSchema,
  StorageManifestSchema,
  StorageRecordSchema,
  WriteOperationSchema,
} from '../src/engine/gen/SignalStorage_pb';
import { create, fromBinary, toBinary } from '../src/engine/net/proto';
import { MemorySignalStore } from '../src/engine/protocol/store';
import { decryptStorageValue, deriveStorageItemKey, deriveStorageManifestKey, deriveStorageServiceKey } from '../src/engine/services/storage';
import { ALICE } from './helpers';

/** A field number no Signal schema uses, so it must survive a read-modify-write as an unknown field. */
export const UNKNOWN_FIELD = new Uint8Array([0xa0, 0x06, 0x01]);

export async function gcm(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(12);
  return concatBytes(iv, await aesGcmEncrypt(key, iv, plaintext));
}

/** Wraps raw ContactRecord bytes in a StorageRecord by hand so they can carry an unknown field. */
function rawContactRecord(contactBytes: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([0x0a, contactBytes.length]), contactBytes);
}

export function hasBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** In-memory storage.signal.org: GET manifest, PUT read, and PUT /v1/storage with version checks. */
export async function serveStorage(masterKey: Uint8Array, recordIkm?: Uint8Array) {
  const storageKey = deriveStorageServiceKey(masterKey);
  const contactKey = randomBytes(16);
  const groupKey = randomBytes(16);
  const accountKey = randomBytes(16);
  const stickerKey = randomBytes(16);
  const unknownKey = randomBytes(16);
  const groupMasterKey = randomBytes(32);
  const profileKey = randomBytes(32);
  const stickerPackId = randomBytes(16);
  const stickerPackKey = randomBytes(32);

  let version = 7n;
  let identifiers: Array<{ raw: Uint8Array; type: ManifestRecord_Identifier_Type }> = [
    { raw: contactKey, type: ManifestRecord_Identifier_Type.CONTACT },
    { raw: groupKey, type: ManifestRecord_Identifier_Type.GROUPV2 },
    { raw: accountKey, type: ManifestRecord_Identifier_Type.ACCOUNT },
    { raw: stickerKey, type: ManifestRecord_Identifier_Type.STICKER_PACK },
    { raw: unknownKey, type: ManifestRecord_Identifier_Type.STORY_DISTRIBUTION_LIST },
  ];
  let manifest = new Uint8Array(0);
  const encodeManifest = async () => {
    const mr = create(ManifestRecordSchema, { version, sourceDevice: 1, recordIkm, identifiers });
    manifest = toBinary(
      StorageManifestSchema,
      create(StorageManifestSchema, { version, value: await gcm(deriveStorageManifestKey(storageKey, version), toBinary(ManifestRecordSchema, mr)) })
    );
  };
  await encodeManifest();

  const records = new Map<string, Uint8Array>();
  const putRaw = async (key: Uint8Array, bytes: Uint8Array) => {
    records.set(toBase64(key), await gcm(deriveStorageItemKey(storageKey, key, recordIkm), bytes));
  };
  const put = (key: Uint8Array, record: any) => putRaw(key, toBinary(StorageRecordSchema, create(StorageRecordSchema, { record })));
  const contactBytes = toBinary(
    ContactRecordSchema,
    create(ContactRecordSchema, { aci: ALICE, e164: '+15553334444', givenName: 'Clara', familyName: 'Oswald', profileKey, blocked: true, systemGivenName: 'Clara' })
  );
  await putRaw(contactKey, rawContactRecord(concatBytes(contactBytes, UNKNOWN_FIELD)));
  await put(groupKey, { case: 'groupV2', value: { masterKey: groupMasterKey, archived: true, markedUnread: true } });
  await put(accountKey, { case: 'account', value: { givenName: 'Me', readReceipts: true, linkPreviews: true, sealedSenderIndicators: true, noteToSelfMarkedUnread: true, universalExpireTimer: 86400 } });
  await put(stickerKey, { case: 'installedStickerPack', value: { packId: stickerPackId, packKey: stickerPackKey, position: 3 } });
  records.set(toBase64(unknownKey), randomBytes(40));

  const urls: string[] = [];
  let conflicts = 0;
  const httpJson = async (_m: string, path: string) => {
    assert.equal(path, '/v1/storage/auth');
    return { username: 'storage-user', password: 'storage-pass' };
  };
  const httpBinary = async (method: string, url: string, body?: Uint8Array | null, headers?: Record<string, string>) => {
    urls.push(`${method} ${url}`);
    assert.equal(headers!.Authorization, 'Basic ' + btoa('storage-user:storage-pass'));
    if (url.endsWith('/v1/storage/manifest')) return manifest;
    if (url.endsWith('/v1/storage/read')) {
      const keys = fromBinary(ReadOperationSchema, body!).readKey;
      return toBinary(StorageItemsSchema, create(StorageItemsSchema, { items: keys.map((k) => ({ key: k, value: records.get(toBase64(k))! })) }));
    }
    assert.ok(url.endsWith('/v1/storage'));
    if (conflicts > 0) {
      conflicts--;
      throw Object.assign(new Error('HTTP 409'), { status: 409 });
    }
    const op = fromBinary(WriteOperationSchema, body!);
    if (op.manifest!.version !== version + 1n) throw Object.assign(new Error('HTTP 409'), { status: 409 });
    const mr = fromBinary(ManifestRecordSchema, await decryptStorageValue(deriveStorageManifestKey(storageKey, op.manifest!.version), op.manifest!.value));
    assert.equal(mr.sourceDevice, 2);
    assert.deepEqual(mr.recordIkm, recordIkm || new Uint8Array(0));
    for (const k of op.deleteKey) records.delete(toBase64(k));
    for (const item of op.insertItem) records.set(toBase64(item.key), item.value);
    for (const id of mr.identifiers) assert.ok(records.has(toBase64(id.raw)), 'manifest names only stored keys');
    version = op.manifest!.version;
    identifiers = mr.identifiers.map((i) => ({ raw: i.raw, type: i.type }));
    await encodeManifest();
    return new Uint8Array(0);
  };
  const readRecordsOf = (type: ManifestRecord_Identifier_Type) =>
    Promise.all(identifiers.filter((i) => i.type === type).map(async (id) => fromBinary(StorageRecordSchema, await decryptStorageValue(deriveStorageItemKey(storageKey, id.raw, recordIkm), records.get(toBase64(id.raw))!)).record));
  const readRecord = async (type: ManifestRecord_Identifier_Type) => {
    const id = identifiers.find((i) => i.type === type)!;
    return decryptStorageValue(deriveStorageItemKey(storageKey, id.raw, recordIkm), records.get(toBase64(id.raw))!);
  };
  return {
    httpJson,
    httpBinary,
    urls,
    groupMasterKey,
    profileKey,
    unknownKey,
    stickerPackId,
    stickerPackKey,
    readRecord,
    readRecordsOf,
    identifiers: () => identifiers,
    version: () => version,
    conflictNext: (n: number) => {
      conflicts = n;
    },
  };
}

export function storageStore(masterKey: Uint8Array) {
  return new MemorySignalStore({
    aci: ALICE,
    number: '',
    deviceId: 2,
    password: 'pw',
    registrationId: 1,
    pniRegistrationId: 2,
    aciIdentityKeyPair: { pubKey: new Uint8Array(33), privKey: new Uint8Array(32) },
    masterKey,
  });
}
