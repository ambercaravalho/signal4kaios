import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { concatBytes, randomBytes, toBase64, uuidToBytes } from './bytes';
import { attachmentPaddedSize, decryptAttachment, encryptAttachment } from './crypto/attachment';
import { aesGcmEncrypt } from './crypto/primitives';
import { ContactDetailsSchema } from './gen/SignalService_pb';
import { GroupAttributeBlobSchema } from './gen/Groups_pb';
import {
  ManifestRecord_Identifier_Type,
  ManifestRecordSchema,
  ReadOperationSchema,
  StorageItemsSchema,
  StorageManifestSchema,
  StorageRecordSchema,
} from './gen/SignalStorage_pb';
import { deriveGroupV2Keys, groupIdFromMasterKey } from './groups-v2';
import { libsignal } from './libsignal';
import { decryptProfile, decryptProfileName, encryptProfileName } from './profiles';
import { create, fromBinary, serviceIdFrom, toBinary } from './proto';
import { deriveStorageItemKey, deriveStorageManifestKey, deriveStorageServiceKey, pullFromStorageService } from './storage-service';
import { MemorySignalStore } from './storage';
import { loadWasmForTests } from './test-support';
import { parseContactsSyncBlob } from './transport';

const ALICE = '11111111-1111-4111-8111-111111111111';

before(() => {
  loadWasmForTests();
});

async function gcm(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(12);
  return concatBytes(iv, await aesGcmEncrypt(key, iv, plaintext));
}

describe('Attachments (Signal-Desktop AttachmentCrypto)', () => {
  it('pads to Signal-Desktop logPadSize buckets', () => {
    assert.equal(attachmentPaddedSize(0), 541);
    assert.equal(attachmentPaddedSize(1), 541);
    assert.equal(attachmentPaddedSize(541), 541);
    assert.equal(attachmentPaddedSize(542), 568);
    assert.equal(attachmentPaddedSize(1021), 1071);
    assert.equal(attachmentPaddedSize(102224512), 102224512);
  });

  it('round-trips with HMAC and digest checks; the pointer size strips the padding', async () => {
    const original = new TextEncoder().encode('Attachment binary content on KaiOS');
    const enc = await encryptAttachment(original);
    assert.equal(enc.ciphertext.length, 16 + 544 + 32);
    const dec = await decryptAttachment(enc.ciphertext, enc.key, enc.digest);
    assert.equal(dec.length, 541);
    assert.deepEqual(dec.subarray(0, original.length), original);

    const tampered = new Uint8Array(enc.ciphertext);
    tampered[20] ^= 1;
    await assert.rejects(decryptAttachment(tampered, enc.key));
    await assert.rejects(decryptAttachment(enc.ciphertext, enc.key, randomBytes(32)));
  });
});

describe('Profiles (Signal-Desktop profile cipher)', () => {
  it('pads names to 53 bytes and splits given/family names at NUL', async () => {
    const profileKey = randomBytes(32);
    const encName = await encryptProfileName('Amber', 'Caravalho', profileKey);
    const raw = Uint8Array.from(atob(encName), (c) => c.charCodeAt(0));
    assert.equal(raw.length, 12 + 53 + 16);
    assert.equal((await decryptProfile(raw, profileKey)).length, 53);
    assert.deepEqual(await decryptProfileName(encName, profileKey), {
      givenName: 'Amber',
      familyName: 'Caravalho',
      fullName: 'Amber Caravalho',
    });
    await assert.rejects(decryptProfileName(encName, randomBytes(32)));
  });

  it('derives profile key versions, commitments, and access keys with zkgroup', () => {
    const profileKey = randomBytes(32);
    const version = libsignal.profileKeyGetVersion(profileKey, ALICE);
    assert.match(version, /^[0-9a-f]{64}$/);
    assert.equal(libsignal.profileKeyGetVersion(profileKey, ALICE), version);
    assert.ok(libsignal.profileKeyGetCommitment(profileKey, ALICE).length > 0);
    assert.equal(libsignal.profileKeyDeriveAccessKey(profileKey).length, 16);
  });

  it('hashes usernames with libsignal and rejects invalid ones', () => {
    assert.equal(libsignal.usernameHash('alice.42').length, 32);
    assert.throws(() => libsignal.usernameHash('no-discriminator'));
  });
});

describe('Storage Service (Signal-Desktop key derivation)', () => {
  async function serveStorage(masterKey: Uint8Array, recordIkm?: Uint8Array) {
    const storageKey = deriveStorageServiceKey(masterKey);
    const contactKey = randomBytes(16);
    const groupKey = randomBytes(16);
    const accountKey = randomBytes(16);
    const groupMasterKey = randomBytes(32);
    const profileKey = randomBytes(32);

    const manifestRecord = create(ManifestRecordSchema, {
      version: 7n,
      sourceDevice: 1,
      recordIkm,
      identifiers: [
        { raw: contactKey, type: ManifestRecord_Identifier_Type.CONTACT },
        { raw: groupKey, type: ManifestRecord_Identifier_Type.GROUPV2 },
        { raw: accountKey, type: ManifestRecord_Identifier_Type.ACCOUNT },
      ],
    });
    const manifest = toBinary(
      StorageManifestSchema,
      create(StorageManifestSchema, {
        version: 7n,
        value: await gcm(deriveStorageManifestKey(storageKey, 7n), toBinary(ManifestRecordSchema, manifestRecord)),
      })
    );

    const records = new Map<string, Uint8Array>();
    const put = async (key: Uint8Array, record: any) => {
      const bytes = toBinary(StorageRecordSchema, create(StorageRecordSchema, { record }));
      records.set(toBase64(key), await gcm(deriveStorageItemKey(storageKey, key, recordIkm), bytes));
    };
    await put(contactKey, { case: 'contact', value: { aci: ALICE, e164: '+15553334444', givenName: 'Clara', familyName: 'Oswald', profileKey, blocked: true } });
    await put(groupKey, { case: 'groupV2', value: { masterKey: groupMasterKey, archived: true } });
    await put(accountKey, { case: 'account', value: { givenName: 'Me', readReceipts: true } });

    const urls: string[] = [];
    const httpJson = async (_m: string, path: string) => {
      assert.equal(path, '/v1/storage/auth');
      return { username: 'storage-user', password: 'storage-pass' };
    };
    const httpBinary = async (method: string, url: string, body?: Uint8Array | null, headers?: Record<string, string>) => {
      urls.push(`${method} ${url}`);
      assert.equal(headers!.Authorization, 'Basic ' + btoa('storage-user:storage-pass'));
      if (url.endsWith('/v1/storage/manifest')) return manifest;
      const keys = fromBinary(ReadOperationSchema, body!).readKey;
      return toBinary(
        StorageItemsSchema,
        create(StorageItemsSchema, { items: keys.map((k) => ({ key: k, value: records.get(toBase64(k))! })) })
      );
    };
    return { httpJson, httpBinary, urls, groupMasterKey, profileKey };
  }

  for (const withIkm of [false, true]) {
    it(`pulls contacts, groups, and account settings from storage.signal.org (${withIkm ? 'recordIkm' : 'legacy'} item keys)`, async () => {
      const masterKey = randomBytes(32);
      const store = new MemorySignalStore({
        aci: ALICE,
        number: '',
        deviceId: 2,
        password: 'pw',
        registrationId: 1,
        pniRegistrationId: 2,
        aciIdentityKeyPair: { pubKey: new Uint8Array(33), privKey: new Uint8Array(32) },
        masterKey,
      });
      const srv = await serveStorage(masterKey, withIkm ? randomBytes(32) : undefined);
      const res = await pullFromStorageService(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org');
      assert.ok(res);
      assert.equal(res.version, 7);
      assert.deepEqual(srv.urls, ['GET https://storage.signal.org/v1/storage/manifest', 'PUT https://storage.signal.org/v1/storage/read']);
      assert.equal(res.contacts.length, 1);
      assert.equal(res.contacts[0].aci, ALICE);
      assert.equal(res.contacts[0].givenName, 'Clara');
      assert.equal(res.contacts[0].blocked, true);
      assert.deepEqual(res.contacts[0].profileKey, srv.profileKey);
      assert.deepEqual(res.groupsV2[0].masterKey, srv.groupMasterKey);
      assert.equal(res.groupsV2[0].archived, true);
      assert.equal(res.account?.givenName, 'Me');
      assert.equal(res.account?.readReceipts, true);
    });
  }
});

describe('Groups V2 (zkgroup)', () => {
  it('derives a stable 32-byte group identifier and decrypts group attribute blobs and members', () => {
    const masterKey = randomBytes(32);
    const keys = deriveGroupV2Keys(masterKey);
    assert.equal(keys.groupIdentifier.length, 32);
    assert.equal(groupIdFromMasterKey(masterKey), keys.internalId);
    assert.equal(keys.sendId, 'group.' + keys.internalId);

    const title = toBinary(GroupAttributeBlobSchema, create(GroupAttributeBlobSchema, { content: { case: 'title', value: 'KaiOS Developers' } }));
    const blob = libsignal.groupEncryptBlob(keys.secretParams, title, 0);
    const decoded = fromBinary(GroupAttributeBlobSchema, libsignal.groupDecryptBlob(keys.secretParams, blob)).content;
    assert.deepEqual(decoded, { case: 'title', value: 'KaiOS Developers' });

    const member = libsignal.groupEncryptServiceId(keys.secretParams, ALICE);
    assert.equal(libsignal.groupDecryptServiceId(keys.secretParams, member), ALICE);
  });
});

describe('Sync and service IDs', () => {
  it('parses delimited ContactDetails records and skips inline avatars', () => {
    const record = (init: any) => {
      const bytes = toBinary(ContactDetailsSchema, create(ContactDetailsSchema, init));
      return concatBytes(new Uint8Array([bytes.length]), bytes);
    };
    const blob = concatBytes(
      record({ aci: ALICE, number: '+15550001111', name: 'Alice', avatar: { contentType: 'image/jpeg', length: 4 } }),
      new Uint8Array([1, 2, 3, 4]),
      record({ aciBinary: uuidToBytes('22222222-2222-4222-8222-222222222222'), expireTimer: 60 })
    );
    const contacts = parseContactsSyncBlob(blob);
    assert.equal(contacts.length, 2);
    assert.equal(contacts[0].name, 'Alice');
    assert.equal(contacts[1].uuid, '22222222-2222-4222-8222-222222222222');
    assert.equal(contacts[1].expireTimer, 60);
  });

  it('reads service IDs from strings or 16/17-byte binaries', () => {
    const raw = uuidToBytes(ALICE);
    assert.equal(serviceIdFrom(undefined, raw), ALICE);
    assert.equal(serviceIdFrom(undefined, concatBytes(new Uint8Array([1]), raw)), 'PNI:' + ALICE);
    assert.equal(serviceIdFrom('PNI:x', raw), 'PNI:x');
    assert.equal(serviceIdFrom(undefined, new Uint8Array(5)), '');
  });
});
