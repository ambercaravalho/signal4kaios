import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { concatBytes, randomBytes, toBase64 } from '../src/engine/bytes';
import { aesGcmEncrypt } from '../src/engine/crypto/primitives';
import { joinedGroupMutation } from '../src/engine/services/group-changes';
import {
  AccountRecord_PhoneNumberSharingMode,
  ContactRecord_NameSchema,
  ContactRecordSchema,
  ManifestRecord_Identifier_Type,
  ManifestRecordSchema,
  ReadOperationSchema,
  StorageItemsSchema,
  StorageManifestSchema,
  StorageRecordSchema,
  WriteOperationSchema,
} from '../src/engine/gen/SignalStorage_pb';
import { adoptOwnProfileKey } from '../src/engine/services/profiles';
import { create, fromBinary, toBinary } from '../src/engine/net/proto';
import {
  decryptStorageValue,
  deriveStorageItemKey,
  deriveStorageManifestKey,
  deriveStorageServiceKey,
  mutateStorage,
  pullFromStorageService,
  setPhoneNumberPrivacy,
  StorageWriteQueue,
} from '../src/engine/services/storage';
import { MemorySignalStore } from '../src/engine/protocol/store';
import { ALICE, BOB } from './helpers';
import { loadWasmForTests } from './support';

before(() => {
  loadWasmForTests();
});

async function gcm(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(12);
  return concatBytes(iv, await aesGcmEncrypt(key, iv, plaintext));
}

describe('Storage Service (Signal-Desktop key derivation)', () => {
  /** A field number no Signal schema uses, so it must survive a read-modify-write as an unknown field. */
  const UNKNOWN_FIELD = new Uint8Array([0xa0, 0x06, 0x01]);

  /** Wraps raw ContactRecord bytes in a StorageRecord by hand so they can carry an unknown field. */
  function rawContactRecord(contactBytes: Uint8Array): Uint8Array {
    return concatBytes(new Uint8Array([0x0a, contactBytes.length]), contactBytes);
  }

  function hasBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
    outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
      for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  }

  /** In-memory storage.signal.org: GET manifest, PUT read, and PUT /v1/storage with version checks. */
  async function serveStorage(masterKey: Uint8Array, recordIkm?: Uint8Array) {
    const storageKey = deriveStorageServiceKey(masterKey);
    const contactKey = randomBytes(16);
    const groupKey = randomBytes(16);
    const accountKey = randomBytes(16);
    const stickerKey = randomBytes(16);
    const groupMasterKey = randomBytes(32);
    const profileKey = randomBytes(32);

    let version = 7n;
    let identifiers: Array<{ raw: Uint8Array; type: ManifestRecord_Identifier_Type }> = [
      { raw: contactKey, type: ManifestRecord_Identifier_Type.CONTACT },
      { raw: groupKey, type: ManifestRecord_Identifier_Type.GROUPV2 },
      { raw: accountKey, type: ManifestRecord_Identifier_Type.ACCOUNT },
      { raw: stickerKey, type: ManifestRecord_Identifier_Type.STICKER_PACK },
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
    records.set(toBase64(stickerKey), randomBytes(40));

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
      stickerKey,
      readRecord,
      identifiers: () => identifiers,
      version: () => version,
      conflictNext: (n: number) => { conflicts = n; },
    };
  }

  function storageStore(masterKey: Uint8Array) {
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

  for (const withIkm of [false, true]) {
    const label = withIkm ? 'recordIkm' : 'legacy';

    it(`pulls contacts, groups, and account settings from storage.signal.org (${label} item keys)`, async () => {
      const masterKey = randomBytes(32);
      const store = storageStore(masterKey);
      const srv = await serveStorage(masterKey, withIkm ? randomBytes(32) : undefined);
      const res = await pullFromStorageService(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org');
      assert.ok(res);
      assert.equal(res.version, 7);
      assert.deepEqual(srv.urls, ['GET https://storage.signal.org/v1/storage/manifest', 'PUT https://storage.signal.org/v1/storage/read']);
      assert.equal(res.contacts.length, 1);
      assert.equal(res.contacts[0].aci, ALICE);
      assert.equal(res.contacts[0].givenName, 'Clara');
      assert.equal(res.contacts[0].blocked, true);
      assert.equal(res.contacts[0].whitelisted, false);
      assert.equal(res.contacts[0].systemContact, true);
      assert.deepEqual(res.contacts[0].profileKey, srv.profileKey);
      assert.deepEqual(res.groupsV2[0].masterKey, srv.groupMasterKey);
      assert.equal(res.groupsV2[0].archived, true);
      assert.equal(res.groupsV2[0].markedUnread, true);
      assert.equal(res.account?.givenName, 'Me');
      assert.equal(res.account?.readReceipts, true);
      assert.equal(res.account?.linkPreviews, true);
      assert.equal(res.account?.sealedSenderIndicators, true);
      assert.equal(res.account?.universalExpireTimer, 86400);
      assert.equal(res.account?.noteToSelfMarkedUnread, true);

      srv.urls.length = 0;
      await pullFromStorageService(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org');
      assert.deepEqual(srv.urls, ['GET https://storage.signal.org/v1/storage/manifest'], 'cached records are not re-read');
    });

    it(`writes changed records under fresh keys and a version+1 manifest (${label} item keys)`, async () => {
      const masterKey = randomBytes(32);
      const store = storageStore(masterKey);
      const srv = await serveStorage(masterKey, withIkm ? randomBytes(32) : undefined);
      const before = srv.identifiers().map((i) => toBase64(i.raw));
      const newGroup = randomBytes(32);
      const changed = await mutateStorage(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org', [
        { type: 'contact', aci: ALICE, update: (c) => { c.blocked = false; c.nickname = create(ContactRecord_NameSchema, { given: 'Clara O.' }); } },
        { type: 'contact', aci: ALICE, update: (c) => { c.archived = true; } },
        { type: 'groupV2', masterKey: newGroup, update: (g) => { g.mutedUntilTimestamp = 99n; } },
        { type: 'account', update: (a) => { a.username = 'clara.42'; a.universalExpireTimer = 3600; a.sealedSenderIndicators = false; setPhoneNumberPrivacy(a, false, false); } },
        { type: 'contact', aci: ALICE, update: (c) => { c.whitelisted = true; } },
      ]);
      assert.equal(changed, true);
      assert.equal(srv.version(), 8n);

      const after = srv.identifiers().map((i) => toBase64(i.raw));
      assert.equal(after.length, 5);
      assert.ok(after.includes(toBase64(srv.stickerKey)), 'unknown record types stay in the manifest');
      assert.ok(after.includes(before[1]), 'the untouched group keeps its key');
      assert.ok(!after.includes(before[0]) && !after.includes(before[2]), 'changed records get new keys');

      const contactBytes = await srv.readRecord(ManifestRecord_Identifier_Type.CONTACT);
      assert.ok(hasBytes(contactBytes, UNKNOWN_FIELD), 'unknown fields survive the write');

      const res = await pullFromStorageService(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org');
      assert.ok(res);
      assert.equal(res.version, 8);
      assert.equal(res.contacts[0].blocked, false);
      assert.equal(res.contacts[0].archived, true);
      assert.equal(res.contacts[0].nicknameGivenName, 'Clara O.');
      assert.equal(res.groupsV2.length, 2);
      assert.equal(res.groupsV2.find((g) => toBase64(g.masterKey) === toBase64(newGroup))?.mutedUntilTimestamp, 99);
      assert.equal(res.account?.username, 'clara.42');
      assert.equal(res.account?.universalExpireTimer, 3600);
      assert.equal(res.account?.sealedSenderIndicators, false);
      assert.equal(res.account?.sharePhoneNumber, false);
      assert.equal(res.account?.findableByNumber, false);
      assert.equal(res.contacts[0].whitelisted, true);

      await mutateStorage(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org', [{ type: 'account', update: (a) => setPhoneNumberPrivacy(a, true, false) }]);
      const shared = await pullFromStorageService(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org');
      assert.equal(shared!.account?.sharePhoneNumber, true);
      assert.equal(shared!.account?.findableByNumber, true, 'a number everybody sees is also findable');
      const account = fromBinary(StorageRecordSchema, await srv.readRecord(ManifestRecord_Identifier_Type.ACCOUNT)).record;
      assert.equal(account.case, 'account');
      assert.equal(account.value!.phoneNumberSharingMode, AccountRecord_PhoneNumberSharingMode.EVERYBODY);
      assert.equal(account.value!.unlistedPhoneNumber, false);
    });
  }

  it('takes on a profile key the phone rotated in the account record', async () => {
    const masterKey = randomBytes(32);
    const store = storageStore(masterKey);
    const oldKey = randomBytes(32);
    await store.saveAccount({ ...(await store.getAccount())!, profileKey: oldKey });
    await store.storeValue('profileKeyCredentials', {
      [ALICE]: { profileKey: toBase64(oldKey), credential: 'AA==', expiresAtSeconds: 2e9 },
      [BOB]: { profileKey: toBase64(randomBytes(32)), credential: 'AA==', expiresAtSeconds: 2e9 },
    });
    const srv = await serveStorage(masterKey);
    const first = await pullFromStorageService(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org');
    assert.equal(await adoptOwnProfileKey(store, first!.account?.profileKey), false, 'an account record without a key changes nothing');

    const newKey = randomBytes(32);
    await mutateStorage(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org', [{ type: 'account', update: (a) => { a.profileKey = newKey; } }]);
    const res = await pullFromStorageService(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org');
    assert.equal(await adoptOwnProfileKey(store, res!.account?.profileKey), true);
    assert.deepEqual((await store.getAccount())!.profileKey, newKey);
    assert.equal((await store.getAccount())!.password, 'pw', 'the rest of the account is kept');
    const cache = (await store.loadValue('profileKeyCredentials')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(cache), [BOB], 'our credential for the old key is dropped');
    assert.equal(await adoptOwnProfileKey(store, res!.account?.profileKey), false);
  });

  it('writes our profile photo path to the account record and reads it back', async () => {
    const masterKey = randomBytes(32);
    const store = storageStore(masterKey);
    const srv = await serveStorage(masterKey);
    await mutateStorage(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org', [{ type: 'account', update: (a) => { a.avatarUrlPath = 'profiles/abc_DEF-1'; } }]);
    const account = fromBinary(StorageRecordSchema, await srv.readRecord(ManifestRecord_Identifier_Type.ACCOUNT)).record;
    assert.equal(account.case, 'account');
    assert.equal(account.value!.avatarUrlPath, 'profiles/abc_DEF-1');
    assert.equal(account.value!.givenName, 'Me', 'the rest of the record is kept');
    const res = await pullFromStorageService(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org');
    assert.equal(res!.account?.avatarUrlPath, 'profiles/abc_DEF-1');
  });

  it('re-reads and retries after a 409, and skips no-op writes', async () => {
    const masterKey = randomBytes(32);
    const store = storageStore(masterKey);
    const srv = await serveStorage(masterKey);
    srv.conflictNext(1);
    await mutateStorage(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org', [
      { type: 'contact', aci: ALICE, update: (c) => { c.blocked = false; } },
    ]);
    assert.equal(srv.version(), 8n);
    assert.equal(srv.urls.filter((u) => u.endsWith('/v1/storage/manifest')).length, 2);

    const unchanged = await mutateStorage(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org', [
      { type: 'contact', aci: ALICE, update: (c) => { c.blocked = false; } },
    ]);
    assert.equal(unchanged, false);
    assert.equal(srv.version(), 8n);

    srv.conflictNext(5);
    await assert.rejects(
      mutateStorage(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org', [{ type: 'contact', aci: ALICE, update: (c) => { c.blocked = true; } }]),
      (e: any) => e.status === 409
    );
  });

  it('marks the records another device wrote since the last pull, but not our own writes', async () => {
    const masterKey = randomBytes(32);
    const ours = storageStore(masterKey);
    const theirs = storageStore(masterKey);
    const srv = await serveStorage(masterKey);
    const pull = async () => (await pullFromStorageService(ours, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org'))!;
    const write = (store: MemorySignalStore, m: any[]) => mutateStorage(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org', m);
    const flags = (r: Awaited<ReturnType<typeof pull>>) => [r.contacts[0].changed, r.groupsV2[0].changed, r.account!.changed];

    assert.deepEqual(flags(await pull()), [true, true, true]);
    assert.deepEqual(flags(await pull()), [false, false, false]);

    await write(theirs, [{ type: 'contact', aci: ALICE, update: (c: any) => { c.archived = true; } }]);
    assert.deepEqual(flags(await pull()), [true, false, false]);

    await write(ours, [{ type: 'account', update: (a: any) => { a.noteToSelfArchived = true; } }]);
    const own = await pull();
    assert.deepEqual(flags(own), [false, false, false]);
    assert.equal(own.account!.noteToSelfArchived, true);

    await write(theirs, [{ type: 'groupV2', masterKey: srv.groupMasterKey, update: (g: any) => { g.archived = false; } }]);
    await write(ours, [{ type: 'contact', aci: ALICE, update: (c: any) => { c.mutedUntilTimestamp = BigInt(Number.MAX_SAFE_INTEGER); } }]);
    assert.deepEqual(flags(await pull()), [false, true, false], 'a record first read during our write is still reported');
  });

  it('adds a Storage Service record for a group joined through its link', async () => {
    const masterKey = randomBytes(32);
    const store = storageStore(masterKey);
    const srv = await serveStorage(masterKey);
    const joined = randomBytes(32);
    assert.equal(await mutateStorage(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org', [joinedGroupMutation(joined)]), true);
    const res = await pullFromStorageService(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org');
    const rec = res!.groupsV2.find((g) => toBase64(g.masterKey) === toBase64(joined));
    assert.ok(rec);
    assert.equal(rec.whitelisted, true);
    assert.equal(rec.blocked, false);
  });

  it('batches queued mutations into one write', async () => {
    const batches: number[] = [];
    let written = 0;
    const q = new StorageWriteQueue(async (m) => { batches.push(m.length); return true; }, () => { written++; }, 5);
    await Promise.all([
      q.enqueue([{ type: 'account', update: () => {} }]),
      q.enqueue([{ type: 'account', update: () => {} }, { type: 'account', update: () => {} }]),
    ]);
    await q.enqueue([{ type: 'account', update: () => {} }]);
    assert.deepEqual(batches, [3, 1]);
    assert.equal(written, 2);
  });
});
