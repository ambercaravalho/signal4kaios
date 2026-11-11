import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as official from '@signalapp/libsignal-client';
import * as zk from '@signalapp/libsignal-client/zkgroup';

import { concatBytes, fromBase64, fromHex, randomBytes, toBase64, toHex, toWebSafeBase64, uuidToBytes } from '../src/engine/bytes';
import { attachmentPaddedSize, decryptAttachment, encryptAttachment } from '../src/engine/crypto/attachment';
import { aesGcmEncrypt } from '../src/engine/crypto/primitives';
import { ContactDetailsSchema, ContentSchema, DataMessage_Flags, SyncMessage_MessageRequestResponse_Type } from '../src/engine/gen/SignalService_pb';
import {
  AccessControl_AccessRequired,
  GroupAttributeBlobSchema,
  GroupChange_ActionsSchema,
  GroupChangeResponseSchema,
  GroupChangeSchema,
  GroupInviteLinkSchema,
  GroupJoinInfoSchema,
  GroupResponseSchema,
  GroupSchema,
  Member_Role,
  MemberPendingAdminApprovalSchema,
  MemberSchema,
} from '../src/engine/gen/Groups_pb';
import {
  addMembersActions,
  applyGroupChange,
  approveRequestsActions,
  cancelGroupJoinRequest,
  fetchGroupJoinInfo,
  inviteLinkActions,
  joinedGroupMutation,
  joinGroupViaLink,
  leaveActions,
  permissionActions,
  removeMembersActions,
  roleActions,
  snapshotGroup,
  titleActions,
} from '../src/engine/services/group-changes';
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
import { decodeGroupState, deriveGroupV2Keys, groupIdFromMasterKey, groupInviteLink, parseGroupLink } from '../src/engine/services/groups-v2';
import { libsignal } from '../src/engine/protocol/libsignal';
import { adoptOwnProfileKey, avatarUploadBody, decryptProfile, decryptProfileName, encryptProfileName, uploadOwnProfile } from '../src/engine/services/profiles';
import { create, fromBinary, serviceIdFrom, toBinary } from '../src/engine/net/proto';
import {
  decryptStorageValue,
  deriveStorageItemKey,
  deriveStorageManifestKey,
  deriveStorageServiceKey,
  mutateStorage,
  pullFromStorageService,
  setPhoneNumberPrivacy,
  StorageWriteQueue,
} from '../src/engine/services/storage-service';
import { MemorySignalStore } from '../src/engine/protocol/store';
import { deleteUsername, setUsername, usernameCandidates, usernameLinkUrl } from '../src/engine/services/usernames';
import { loadWasmForTests } from './support';
import { contentToNormalizedFrame, decodeAttachmentDescriptor, parseContactsSyncBlob } from '../src/engine/net/receive';
import { reportSpam } from '../src/engine/services/report-spam';
import { diffGroupState, groupChangeAuthor, isDecodedGroup } from '../src/engine/services/group-updates';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const DAVE = '44444444-4444-4444-8444-444444444444';
const ERIN = '55555555-5555-4555-8555-555555555555';

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

  it('uploads whether everybody sees our number as an encrypted byte', async () => {
    const profileKey = randomBytes(32);
    const store = new MemorySignalStore({
      aci: ALICE,
      number: '+15550001111',
      deviceId: 2,
      password: 'pw',
      registrationId: 1,
      pniRegistrationId: 2,
      aciIdentityKeyPair: { pubKey: new Uint8Array(33), privKey: new Uint8Array(32) },
      profileKey,
    });
    const puts: any[] = [];
    const httpJson = async (method: string, path: string, body: any) => {
      if (method === 'GET') throw Object.assign(new Error('HTTP 404'), { status: 404 });
      assert.equal(path, '/v1/profile');
      puts.push(body);
      return {};
    };
    for (const share of [true, false]) await uploadOwnProfile(store, httpJson as any, { name: 'Amber C', sharePhoneNumber: share });
    await uploadOwnProfile(store, httpJson as any, { sharePhoneNumber: true });
    assert.equal(puts.length, 2, 'no profile is written without a name');
    const bytes = await Promise.all(puts.map(async (b) => Array.from(await decryptProfile(fromBase64(b.phoneNumberSharing), profileKey))));
    assert.deepEqual(bytes, [[1], [0]]);
    assert.deepEqual(await decryptProfileName(puts[0].name, profileKey), { givenName: 'Amber', familyName: 'C', fullName: 'Amber C' });
  });

  describe('profile photo (Signal-Desktop writeProfile and uploadAvatar)', () => {
    const FORM = { key: 'profiles/AbC_d-9', credential: 'AKIA/20261111/us-east-1/s3/aws4_request', acl: 'private', algorithm: 'AWS4-HMAC-SHA256', date: '20261111T120000Z', policy: 'eyJwb2xpY3kiOnRydWV9', signature: 'deadbeef' };

    function setup(formResponse: unknown = FORM) {
      const profileKey = randomBytes(32);
      const store = new MemorySignalStore({
        aci: ALICE,
        number: '+15550001111',
        deviceId: 2,
        password: 'pw',
        registrationId: 1,
        pniRegistrationId: 2,
        aciIdentityKeyPair: { pubKey: new Uint8Array(33), privKey: new Uint8Array(32) },
        profileKey,
      });
      const puts: any[] = [];
      const posts: Array<{ url: string; body: Uint8Array; headers: Record<string, string> }> = [];
      const httpJson = async (method: string, _path: string, body: any) => {
        if (method === 'GET') throw Object.assign(new Error('HTTP 404'), { status: 404 });
        puts.push(body);
        return body.avatar && !body.sameAvatar ? formResponse : null;
      };
      const httpBinary = async (method: string, url: string, body?: Uint8Array | null, headers?: Record<string, string>) => {
        assert.equal(method, 'POST');
        posts.push({ url, body: body!, headers: headers || {} });
        return new Uint8Array(0);
      };
      return { profileKey, store, puts, posts, httpJson: httpJson as any, httpBinary };
    }

    it('keeps, replaces, or removes the photo with the avatar flags Desktop sends', async () => {
      const t = setup();
      assert.deepEqual(await uploadOwnProfile(t.store, t.httpJson, { name: 'Amber', sharePhoneNumber: false }), {});
      const photo = randomBytes(3000);
      const added = await uploadOwnProfile(t.store, t.httpJson, { name: 'Amber', sharePhoneNumber: false, avatar: photo }, undefined, { httpBinary: t.httpBinary });
      assert.deepEqual(added, { avatarUrlPath: FORM.key });
      assert.deepEqual(await uploadOwnProfile(t.store, t.httpJson, { name: 'Amber', sharePhoneNumber: false, avatar: null }), { avatarUrlPath: null });
      assert.deepEqual(
        t.puts.map((b) => [b.avatar, b.sameAvatar]),
        [
          [true, true],
          [true, false],
          [false, false],
        ]
      );
      assert.equal(t.posts.length, 1, 'only a new photo is uploaded');
    });

    it('posts the form fields in Desktop’s order with the encrypted photo intact', async () => {
      const t = setup();
      const photo = randomBytes(5000);
      await uploadOwnProfile(t.store, t.httpJson, { name: 'Amber', sharePhoneNumber: false, avatar: photo }, undefined, { httpBinary: t.httpBinary });
      const { url, body, headers } = t.posts[0];
      assert.equal(url, 'https://cdn.signal.org/');
      const m = /^multipart\/form-data; boundary=(-{16}[0-9a-f]{32})$/.exec(headers['Content-Type']);
      assert.ok(m, headers['Content-Type']);
      const boundary = m![1];
      const text = new TextDecoder('latin1').decode(body);
      const names = Array.from(text.matchAll(/Content-Disposition: form-data; name="([^"]+)"/g)).map((x) => x[1]);
      assert.deepEqual(names, ['key', 'x-amz-credential', 'acl', 'x-amz-algorithm', 'x-amz-date', 'policy', 'x-amz-signature', 'Content-Type', 'file']);
      assert.ok(text.includes(`name="key"\r\n\r\n${FORM.key}\r\n--${boundary}`));
      assert.ok(text.includes(`name="x-amz-signature"\r\n\r\n${FORM.signature}\r\n`));

      const head = new TextEncoder().encode(`name="file"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      let start = -1;
      for (let i = 0; i + head.length <= body.length && start < 0; i++) if (head.every((b, j) => body[i + j] === b)) start = i + head.length;
      const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
      assert.deepEqual(body.subarray(body.length - tail.length), tail);
      const encrypted = body.subarray(start, body.length - tail.length);
      assert.equal(encrypted.length, 12 + photo.length + 16, 'the photo is encrypted without padding');
      assert.deepEqual(await decryptProfile(encrypted, t.profileKey), photo);
    });

    it('rejects an upload form that could break out of its field', async () => {
      for (const bad of [null, 'form', { ...FORM, key: undefined }, { ...FORM, policy: '' }, { ...FORM, acl: 'private\r\n--x' }, { ...FORM, signature: 'a b' }, { ...FORM, key: '../x' }, { ...FORM, key: '/profiles/x' }]) {
        const t = setup(bad);
        await assert.rejects(uploadOwnProfile(t.store, t.httpJson, { name: 'Amber', sharePhoneNumber: false, avatar: randomBytes(10) }, undefined, { httpBinary: t.httpBinary }), /avatar upload form/i, JSON.stringify(bad));
        assert.equal(t.posts.length, 0);
      }
    });

    it('lays out the multipart body exactly', () => {
      const { body, contentType } = avatarUploadBody(FORM, new Uint8Array([1, 2, 3]), '0123456789abcdef0123456789abcdef');
      const b = '----------------0123456789abcdef0123456789abcdef';
      assert.equal(contentType, `multipart/form-data; boundary=${b}`);
      const field = (n: string, v: string) => `--${b}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
      const expected =
        field('key', FORM.key) +
        field('x-amz-credential', FORM.credential) +
        field('acl', FORM.acl) +
        field('x-amz-algorithm', FORM.algorithm) +
        field('x-amz-date', FORM.date) +
        field('policy', FORM.policy) +
        field('x-amz-signature', FORM.signature) +
        field('Content-Type', 'application/octet-stream') +
        `--${b}\r\nContent-Disposition: form-data; name="file"\r\nContent-Type: application/octet-stream\r\n\r\n\x01\x02\x03\r\n--${b}--\r\n`;
      assert.equal(new TextDecoder('latin1').decode(body), expected);
    });
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

describe('Groups V2 changes (PATCH /v2/groups/)', () => {
  const PNI = '99999999-9999-4999-8999-999999999999';

  /** A storage server holding one group (Alice admin, Bob member, Carol invited) that applies title changes and checks auth presentations. */
  function serveGroup(opts: { aliceAdmin?: boolean; bobAdmin?: boolean } = {}) {
    const serverSecret = zk.ServerSecretParams.generate();
    const serverPublic = new Uint8Array(serverSecret.getPublicParams().serialize());
    const masterKey = randomBytes(32);
    const keys = deriveGroupV2Keys(masterKey);
    const enc = (id: string) => libsignal.groupEncryptServiceId(keys.secretParams, id);
    const blob = (content: any) => libsignal.groupEncryptBlob(keys.secretParams, toBinary(GroupAttributeBlobSchema, create(GroupAttributeBlobSchema, { content })), 0);
    const group = create(GroupSchema, {
      version: 4,
      title: blob({ case: 'title', value: 'Before' }),
      accessControl: { attributes: AccessControl_AccessRequired.MEMBER, members: AccessControl_AccessRequired.MEMBER, addFromInviteLink: AccessControl_AccessRequired.UNSATISFIABLE },
      members: [
        { userId: enc(ALICE), role: opts.aliceAdmin === false ? Member_Role.DEFAULT : Member_Role.ADMINISTRATOR },
        { userId: enc(BOB), role: opts.bobAdmin ? Member_Role.ADMINISTRATOR : Member_Role.DEFAULT },
      ],
      membersPendingProfileKey: [{ member: { userId: enc(CAROL), role: Member_Role.DEFAULT } }],
    });

    const today = Math.floor(Date.now() / 86400000) * 86400;
    const credential = new zk.ServerZkAuthOperations(serverSecret).issueAuthCredentialWithPniZkc(
      official.Aci.fromUuid(ALICE),
      official.Pni.fromUuid(PNI),
      today
    );
    const httpJson = async (_m: string, path: string) => {
      assert.match(path, /^\/v1\/certificate\/auth\/group\?/);
      return { credentials: [{ credential: toBase64(credential.serialize()), redemptionTime: today }] };
    };

    const calls: string[] = [];
    let respond: number[] = [];
    const httpBinary = async (method: string, url: string, body?: Uint8Array | null, headers?: Record<string, string>) => {
      calls.push(method);
      assert.equal(url, 'https://storage.signal.org/v2/groups/');
      const [publicHex, presentationHex] = atob(headers!.Authorization.replace(/^Basic /, '')).split(':');
      assert.equal(publicHex, toHex(keys.publicParams));
      new zk.ServerZkAuthOperations(serverSecret).verifyAuthCredentialPresentation(
        new zk.GroupPublicParams(new Uint8Array(keys.publicParams)),
        new zk.AuthCredentialPresentation(new Uint8Array(fromHex(presentationHex)))
      );
      if (method === 'GET') {
        const isMember = group.members.some((m) => libsignal.groupDecryptServiceId(keys.secretParams, m.userId) === ALICE);
        if (!isMember) throw Object.assign(new Error('HTTP 403'), { status: 403 });
        return toBinary(GroupResponseSchema, create(GroupResponseSchema, { group }));
      }
      const status = respond.shift();
      if (status) throw Object.assign(new Error('HTTP ' + status), { status });
      const actions = fromBinary(GroupChange_ActionsSchema, body!);
      assert.equal(actions.version, group.version + 1);
      if (actions.modifyTitle) group.title = actions.modifyTitle.title;
      const deleted = actions.deleteMembers.map((d) => toBase64(d.deletedUserId));
      group.members = group.members.filter((m) => !deleted.includes(toBase64(m.userId)));
      group.version = actions.version;
      return toBinary(GroupChangeResponseSchema, create(GroupChangeResponseSchema, { groupChange: { actions: body!, serverSignature: randomBytes(64) } }));
    };

    const store = new MemorySignalStore({
      aci: ALICE,
      pni: 'PNI:' + PNI,
      number: '',
      deviceId: 2,
      password: 'pw',
      registrationId: 1,
      pniRegistrationId: 2,
      aciIdentityKeyPair: { pubKey: new Uint8Array(33), privKey: new Uint8Array(32) },
    });
    const deps = { store, httpJson: httpJson as any, httpBinary, serverUrl: 'https://chat.signal.org', serverPublicParams: serverPublic };
    return { deps, masterKey, keys, group, calls, respondWith: (s: number[]) => { respond = s; } };
  }

  it('applies a title change at revision+1 and notifies everyone in the group', async () => {
    const srv = serveGroup();
    const res = await applyGroupChange(srv.deps, srv.masterKey, (snap) => titleActions(snap, 'After'));
    assert.ok(res);
    assert.equal(res.revision, 5);
    assert.equal(res.state.name, 'After');
    assert.deepEqual(res.state.pending, [CAROL]);
    assert.deepEqual(res.notify.sort(), [BOB, CAROL].sort());
    const signed = fromBinary(GroupChangeSchema, res.groupChange);
    assert.equal(fromBinary(GroupChange_ActionsSchema, signed.actions).version, 5);
    assert.deepEqual(srv.calls, ['GET', 'PATCH', 'GET']);
  });

  it('rebuilds once after a 409 and maps 403 to GroupChangeForbidden', async () => {
    const srv = serveGroup();
    srv.respondWith([409]);
    const res = await applyGroupChange(srv.deps, srv.masterKey, (snap) => titleActions(snap, 'Retried'));
    assert.equal(res!.state.name, 'Retried');
    assert.deepEqual(srv.calls, ['GET', 'PATCH', 'GET', 'PATCH', 'GET']);

    srv.respondWith([403]);
    await assert.rejects(applyGroupChange(srv.deps, srv.masterKey, (snap) => titleActions(snap, 'Nope')), (e: any) => e.name === 'GroupChangeForbidden');
    assert.equal(await applyGroupChange(srv.deps, srv.masterKey, () => null), null);
  });

  it('leaves a group and still reports who to notify once the server hides it', async () => {
    const srv = serveGroup({ bobAdmin: true });
    const res = await applyGroupChange(srv.deps, srv.masterKey, (snap) => leaveActions(snap));
    assert.ok(res);
    assert.equal(res.revision, 5);
    assert.deepEqual(res.state.members, [BOB]);
    assert.deepEqual(res.notify.sort(), [BOB, CAROL].sort());
  });

  it('builds member, role, permission, link, and leave actions against the current group', () => {
    const srv = serveGroup();
    const snap = snapshotGroup(srv.keys, srv.group, ALICE);
    const userId = (id: string) => snap.members.get(id) || snap.pending.get(id);

    const removed = removeMembersActions(snap, [BOB, CAROL])!;
    assert.deepEqual(removed.deleteMembers![0].deletedUserId, userId(BOB));
    assert.deepEqual(removed.deleteMembersPendingProfileKey![0].deletedUserId, userId(CAROL));

    const promoted = roleActions(snap, [BOB, ALICE], true)!;
    assert.equal(promoted.modifyMemberRoles!.length, 1);
    assert.equal(promoted.modifyMemberRoles![0].role, Member_Role.ADMINISTRATOR);

    const added = addMembersActions(snap, [{ aci: DAVE }, { aci: BOB }, { aci: ERIN, presentation: new Uint8Array([1, 2]) }])!;
    assert.equal(libsignal.groupDecryptServiceId(srv.keys.secretParams, added.addMembersPendingProfileKey![0].added!.member!.userId as Uint8Array), DAVE);
    assert.deepEqual(added.addMembers![0].added!.presentation, new Uint8Array([1, 2]));

    assert.equal(permissionActions(snap, { add_members: 'every-member', edit_group: 'every-member', send_messages: 'every-member' }), null);
    assert.deepEqual(permissionActions(snap, { edit_group: 'only-admins' }), { modifyAttributesAccess: { attributesAccess: AccessControl_AccessRequired.ADMINISTRATOR } });

    const link = inviteLinkActions(snap, 'enabled')!;
    assert.equal(link.modifyAddFromInviteLinkAccess!.addFromInviteLinkAccess, AccessControl_AccessRequired.ANY);
    assert.equal((link.modifyInviteLinkPassword!.inviteLinkPassword as Uint8Array).length, 16);
    assert.equal(inviteLinkActions(snap, 'disabled'), null);

    assert.throws(() => leaveActions(snap), (e: any) => e.name === 'LastAdmin');
    const asBob = snapshotGroup(srv.keys, srv.group, BOB);
    assert.deepEqual(leaveActions(asBob).deleteMembers![0].deletedUserId, userId(BOB));
    assert.ok(leaveActions(snapshotGroup(srv.keys, srv.group, CAROL)).deleteMembersPendingProfileKey!.length === 1);
    assert.throws(() => leaveActions(snapshotGroup(srv.keys, srv.group, DAVE)), (e: any) => e.name === 'NotAMember');

    const linked = fromBinary(GroupSchema, toBinary(GroupSchema, srv.group));
    linked.inviteLinkPassword = new Uint8Array(16).fill(7);
    linked.accessControl!.addFromInviteLink = AccessControl_AccessRequired.ADMINISTRATOR;
    const decoded = decodeGroupState(srv.keys, linked);
    assert.equal(decoded.link_mode, 'enabled-with-approval');
    assert.match(decoded.invite_link, /^https:\/\/signal\.group\/#[A-Za-z0-9_-]+$/);
    const inv = fromBinary(GroupInviteLinkSchema, fromBase64(decoded.invite_link.split('#')[1]));
    assert.equal(inv.contents.case, 'contentsV1');
    assert.deepEqual(inv.contents.value!.groupMasterKey, srv.masterKey);
  });

  it('approves join requests like Signal-Desktop and denies them by deleting the request', () => {
    const srv = serveGroup();
    const requested = libsignal.groupEncryptServiceId(srv.keys.secretParams, DAVE);
    srv.group.membersPendingAdminApproval = [create(MemberPendingAdminApprovalSchema, { userId: requested })];
    assert.deepEqual(decodeGroupState(srv.keys, srv.group).requesting, [DAVE]);
    const snap = snapshotGroup(srv.keys, srv.group, ALICE);
    assert.deepEqual(approveRequestsActions(snap, [DAVE, BOB]), { promoteMembersPendingAdminApproval: [{ userId: requested, role: Member_Role.DEFAULT }] });
    assert.equal(approveRequestsActions(snap, [BOB]), null);
    assert.deepEqual(removeMembersActions(snap, [DAVE])!.deleteMembersPendingAdminApproval, [{ deletedUserId: requested }]);
  });

  it('reads who made a signed group change only for the revision it claims', () => {
    const srv = serveGroup();
    const actions = toBinary(GroupChange_ActionsSchema, create(GroupChange_ActionsSchema, { sourceUserId: libsignal.groupEncryptServiceId(srv.keys.secretParams, BOB), version: 5 }));
    const signed = toBinary(GroupChangeSchema, create(GroupChangeSchema, { actions, serverSignature: randomBytes(64) }));
    assert.equal(groupChangeAuthor(srv.keys, signed, 5), BOB);
    assert.equal(groupChangeAuthor(srv.keys, signed, 6), '');
    assert.equal(groupChangeAuthor(srv.keys, new Uint8Array(0), 5), '');
    assert.equal(groupChangeAuthor(srv.keys, new Uint8Array([1, 2, 3]), 5), '');
  });
});

describe('Joining through a group link', () => {
  const PNI = '99999999-9999-4999-8999-999999999999';

  /** A storage server with Bob's group behind a link; Alice (us) is not in it yet. */
  function serveLinkGroup(approval: boolean) {
    const serverSecret = zk.ServerSecretParams.generate();
    const serverPublic = new Uint8Array(serverSecret.getPublicParams().serialize());
    const masterKey = randomBytes(32);
    const password = randomBytes(16);
    const keys = deriveGroupV2Keys(masterKey);
    const enc = (id: string) => libsignal.groupEncryptServiceId(keys.secretParams, id);
    const blob = (content: any) => libsignal.groupEncryptBlob(keys.secretParams, toBinary(GroupAttributeBlobSchema, create(GroupAttributeBlobSchema, { content })), 0);
    const group = create(GroupSchema, {
      version: 9,
      title: blob({ case: 'title', value: 'Hikers' }),
      description: blob({ case: 'descriptionText', value: 'Weekend walks' }),
      inviteLinkPassword: password,
      accessControl: { attributes: AccessControl_AccessRequired.MEMBER, members: AccessControl_AccessRequired.MEMBER, addFromInviteLink: approval ? AccessControl_AccessRequired.ADMINISTRATOR : AccessControl_AccessRequired.ANY },
      members: [
        { userId: enc(BOB), role: Member_Role.ADMINISTRATOR },
        { userId: enc(CAROL), role: Member_Role.DEFAULT },
      ],
    });
    const today = Math.floor(Date.now() / 86400000) * 86400;
    const credential = new zk.ServerZkAuthOperations(serverSecret).issueAuthCredentialWithPniZkc(official.Aci.fromUuid(ALICE), official.Pni.fromUuid(PNI), today);
    const httpJson = async () => ({ credentials: [{ credential: toBase64(credential.serialize()), redemptionTime: today }] });

    const isAlice = (userId: Uint8Array) => libsignal.groupDecryptServiceId(keys.secretParams, userId) === ALICE;
    const presentation = new Uint8Array([4, 5, 6]);
    const calls: string[] = [];
    let respond: number[] = [];
    const httpBinary = async (method: string, url: string, body?: Uint8Array | null, headers?: Record<string, string>) => {
      calls.push(method + ' ' + url.replace('https://storage.signal.org', ''));
      const [publicHex, presentationHex] = atob(headers!.Authorization.replace(/^Basic /, '')).split(':');
      assert.equal(publicHex, toHex(keys.publicParams));
      new zk.ServerZkAuthOperations(serverSecret).verifyAuthCredentialPresentation(
        new zk.GroupPublicParams(new Uint8Array(keys.publicParams)),
        new zk.AuthCredentialPresentation(new Uint8Array(fromHex(presentationHex)))
      );
      const pending = group.membersPendingAdminApproval.some((p) => isAlice(p.userId));
      const linkOk = (pw: string) => pw === toWebSafeBase64(password);
      const join = /\/v2\/groups\/join\/(.*)$/.exec(url);
      if (method === 'GET' && join) {
        if (!(join[1] ? linkOk(join[1]) : pending)) throw Object.assign(new Error('HTTP 403'), { status: 403 });
        return toBinary(
          GroupJoinInfoSchema,
          create(GroupJoinInfoSchema, {
            publicKey: keys.publicParams,
            title: group.title,
            description: group.description,
            memberCount: group.members.length,
            addFromInviteLink: group.accessControl!.addFromInviteLink,
            version: group.version,
            pendingAdminApproval: pending,
          })
        );
      }
      if (method === 'GET') {
        if (!group.members.some((m) => isAlice(m.userId))) throw Object.assign(new Error('HTTP 403'), { status: 403 });
        return toBinary(GroupResponseSchema, create(GroupResponseSchema, { group }));
      }
      assert.equal(method, 'PATCH');
      const query = /\/v2\/groups\/\?inviteLinkPassword=(.+)$/.exec(url);
      assert.ok(query && linkOk(query[1]), 'the link password goes with the change');
      const status = respond.shift();
      if (status) {
        if (status === 409) group.version++;
        throw Object.assign(new Error('HTTP ' + status), { status });
      }
      const actions = fromBinary(GroupChange_ActionsSchema, body!);
      assert.equal(actions.version, group.version + 1);
      for (const a of actions.addMembers) {
        assert.deepEqual(a.added!.presentation, presentation);
        group.members.push(create(MemberSchema, { userId: enc(ALICE), role: a.added!.role }));
      }
      for (const a of actions.addMembersPendingAdminApproval) {
        assert.deepEqual(a.added!.presentation, presentation);
        group.membersPendingAdminApproval.push(create(MemberPendingAdminApprovalSchema, { userId: enc(ALICE) }));
      }
      const withdrawn = actions.deleteMembersPendingAdminApproval.map((d) => toBase64(d.deletedUserId));
      group.membersPendingAdminApproval = group.membersPendingAdminApproval.filter((p) => !withdrawn.includes(toBase64(p.userId)));
      group.version = actions.version;
      return toBinary(GroupChangeResponseSchema, create(GroupChangeResponseSchema, { groupChange: { actions: body!, serverSignature: randomBytes(64) } }));
    };
    const store = new MemorySignalStore({
      aci: ALICE,
      pni: 'PNI:' + PNI,
      number: '',
      deviceId: 2,
      password: 'pw',
      registrationId: 1,
      pniRegistrationId: 2,
      aciIdentityKeyPair: { pubKey: new Uint8Array(33), privKey: new Uint8Array(32) },
    });
    const deps = { store, httpJson: httpJson as any, httpBinary, serverUrl: 'https://chat.signal.org', serverPublicParams: serverPublic };
    return { deps, masterKey, password, keys, group, presentation, calls, link: groupInviteLink(masterKey, password), respondWith: (s: number[]) => { respond = s; } };
  }

  it('reads the master key and password back out of a group link', () => {
    const masterKey = randomBytes(32);
    const password = randomBytes(16);
    const link = groupInviteLink(masterKey, password);
    for (const url of [link, link.replace('https://', 'sgnl://'), '  ' + link + '\n']) {
      const parsed = parseGroupLink(url);
      assert.ok(parsed);
      assert.deepEqual(parsed.masterKey, masterKey);
      assert.deepEqual(parsed.password, password);
    }
    for (const bad of ['https://signal.group/', 'https://signal.group/#', 'https://evil.example/#' + link.split('#')[1], 'https://signal.group/#AAAA', link + '/x']) {
      assert.equal(parseGroupLink(bad), null, bad);
    }
  });

  it('shows the group behind a link with the link password', async () => {
    const srv = serveLinkGroup(true);
    const info = await fetchGroupJoinInfo(srv.deps, srv.masterKey, srv.password);
    assert.deepEqual(info, { title: 'Hikers', description: 'Weekend walks', memberCount: 2, revision: 9, approvalRequired: true, pending: false });
    assert.deepEqual(srv.calls, ['GET /v2/groups/join/' + toWebSafeBase64(srv.password)]);
    await assert.rejects(fetchGroupJoinInfo(srv.deps, srv.masterKey, randomBytes(16)), (e: any) => e.name === 'GroupLinkInvalid');
    srv.group.accessControl!.addFromInviteLink = AccessControl_AccessRequired.UNSATISFIABLE;
    await assert.rejects(fetchGroupJoinInfo(srv.deps, srv.masterKey, srv.password), (e: any) => e.name === 'GroupLinkInvalid');
  });

  it('joins straight in with addMembers when the link needs no approval', async () => {
    const srv = serveLinkGroup(false);
    const res = await joinGroupViaLink(srv.deps, srv.masterKey, srv.password, srv.presentation);
    assert.equal(res.joined, true);
    assert.equal(res.revision, 10);
    assert.equal(fromBinary(GroupChange_ActionsSchema, fromBinary(GroupChangeSchema, res.groupChange).actions).version, 10);
    const state = decodeGroupState(srv.keys, srv.group);
    assert.deepEqual(state.members.sort(), [ALICE, BOB, CAROL].sort());
    assert.ok(!state.admins.includes(ALICE));
  });

  it('asks to join with addMembersPendingAdminApproval, retries after a 409, and cancels the request', async () => {
    const srv = serveLinkGroup(true);
    srv.respondWith([409]);
    const res = await joinGroupViaLink(srv.deps, srv.masterKey, srv.password, srv.presentation);
    assert.equal(res.joined, false);
    assert.equal(res.revision, 11);
    assert.deepEqual(decodeGroupState(srv.keys, srv.group).requesting, [ALICE]);
    assert.equal(srv.calls.filter((c) => c.startsWith('PATCH')).length, 2);

    const again = await joinGroupViaLink(srv.deps, srv.masterKey, srv.password, srv.presentation);
    assert.equal(again.joined, false);
    assert.equal(again.groupChange.length, 0, 'an existing request is not sent twice');
    assert.equal((await fetchGroupJoinInfo(srv.deps, srv.masterKey)).pending, true, 'a pending request reads without the password');

    srv.calls.length = 0;
    assert.equal(await cancelGroupJoinRequest(srv.deps, srv.masterKey, srv.password), 12);
    assert.deepEqual(decodeGroupState(srv.keys, srv.group).requesting, []);
    assert.deepEqual(srv.calls.map((c) => c.split('?')[0]), ['GET /v2/groups/join/' + toWebSafeBase64(srv.password), 'PATCH /v2/groups/']);
    assert.equal(await cancelGroupJoinRequest(srv.deps, srv.masterKey, srv.password), 12, 'nothing to cancel any more');
  });
});

describe('Group update lines', () => {
  const base = {
    id: 'group.X',
    internal_id: 'X',
    masterKey: '',
    revision: 4,
    name: 'Before',
    description: '',
    members: [ALICE, BOB],
    admins: [ALICE],
    pending: [CAROL],
    requesting: [DAVE],
    expireTimer: 0,
    blocked: false,
    permissions: { add_members: 'every-member' as const, edit_group: 'only-admins' as const, send_messages: 'every-member' as const },
    link_mode: 'enabled-with-approval' as const,
    invite_link: 'https://signal.group/#a',
  };

  it('describes each change, crediting the author only when it is known', () => {
    const next = {
      ...base,
      revision: 5,
      name: 'After',
      expireTimer: 86400,
      members: [ALICE, BOB, DAVE, ERIN],
      admins: [ALICE, BOB],
      pending: [],
      requesting: [],
      permissions: { ...base.permissions, send_messages: 'only-admins' as const },
      invite_link: 'https://signal.group/#b',
    };
    assert.deepEqual(diffGroupState(base, next, ALICE, ALICE), [
      { change: 'title', text: 'After' },
      { change: 'timer', seconds: 86400 },
      { change: 'permSend', value: 'only-admins' },
      { change: 'linkReset' },
      { change: 'requestApproved', target: DAVE },
      { change: 'memberAdded', target: ERIN },
      { change: 'adminAdded', target: BOB },
      { change: 'inviteRemoved', count: 1 },
    ]);
    const left = diffGroupState(base, { ...base, revision: 5, members: [ALICE], pending: [], requesting: [] }, CAROL, ALICE);
    assert.deepEqual(left, [{ change: 'memberRemoved', target: BOB }, { change: 'inviteDeclined', target: CAROL }, { change: 'requestDenied', target: DAVE }]);
    assert.deepEqual(diffGroupState(base, { ...base, revision: 5, members: [ALICE] }, BOB, ALICE), [{ change: 'left', target: BOB }]);
    assert.deepEqual(diffGroupState(base, { ...base, revision: 5, members: [ALICE, BOB, ERIN] }, ERIN, ALICE), [{ change: 'joinedViaLink', target: ERIN }]);
    assert.deepEqual(diffGroupState(base, { ...base, revision: 5, pending: [CAROL, ALICE, ERIN] }, '', ALICE), [
      { change: 'invited', target: ALICE, count: 1 },
      { change: 'invited', count: 1 },
    ]);
    assert.deepEqual(diffGroupState(base, { ...base, revision: 5, link_mode: 'disabled', invite_link: '' }, '', ALICE), [{ change: 'link', value: 'disabled', from: 'enabled-with-approval' }]);
    assert.deepEqual(diffGroupState(base, { ...base, revision: 5 }, ALICE, ALICE), []);
    assert.equal(isDecodedGroup({ id: 'group.X', name: 'Group', members: [BOB], admins: [] }), false);
    assert.equal(isDecodedGroup(base), true);
  });
});

describe('Usernames (reserve, confirm, link)', () => {
  const HANDLE = '66666666-6666-4666-8666-666666666666';

  function usernameServer(reserveStatus = 200, confirmStatus = 200) {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const httpJson = async (method: string, path: string, body: any) => {
      calls.push({ method, path, body });
      const fail = (status: number) => Object.assign(new Error('HTTP ' + status), { status });
      if (path.endsWith('/reserve')) {
        if (reserveStatus !== 200) throw fail(reserveStatus);
        return { usernameHash: body.usernameHashes[1] };
      }
      if (path.endsWith('/confirm')) {
        if (confirmStatus !== 200) throw fail(confirmStatus);
        return { usernameHash: body.usernameHash, usernameLinkHandle: HANDLE };
      }
      return {};
    };
    const store = new MemorySignalStore({
      aci: ALICE,
      pni: '',
      number: '',
      deviceId: 2,
      password: 'pw',
      registrationId: 1,
      pniRegistrationId: 2,
      aciIdentityKeyPair: { pubKey: new Uint8Array(33), privKey: new Uint8Array(32) },
    });
    return { calls, httpJson: httpJson as any, store };
  }

  it('confirms the candidate the server reserved with a proof and a link the official library opens', async () => {
    const srv = usernameServer();
    const res = await setUsername(srv.store, srv.httpJson, 'kaios');
    const [reserve, confirm] = srv.calls;
    assert.equal(reserve.method, 'PUT');
    assert.ok(reserve.body.usernameHashes.length > 1);
    assert.match(res.username, /^kaios\.\d{2,}$/);
    assert.deepEqual(fromBase64(confirm.body.usernameHash), new Uint8Array(official.usernames.hash(res.username)));
    official.usernames.verifyProof(Buffer.from(fromBase64(confirm.body.zkProof)), official.usernames.hash(res.username));
    const encryptedUsername = Buffer.from(fromBase64(confirm.body.encryptedUsername));
    assert.equal(official.usernames.decryptUsernameLink({ entropy: Buffer.from(res.entropy), encryptedUsername }), res.username);
    assert.equal(res.serverId, HANDLE);

    const url = usernameLinkUrl(res.entropy, uuidToBytes(HANDLE));
    assert.ok(url.startsWith('https://signal.me/#eu/'));
    assert.deepEqual(fromBase64(url.slice('https://signal.me/#eu/'.length)), concatBytes(res.entropy, uuidToBytes(HANDLE)));
  });

  it('takes a typed number as-is and keeps the link entropy across changes', async () => {
    const srv = usernameServer();
    const entropy = randomBytes(32);
    srv.httpJson = (async (method: string, path: string, body: any) => {
      srv.calls.push({ method, path, body });
      return path.endsWith('/reserve') ? { usernameHash: body.usernameHashes[0] } : { usernameLinkHandle: HANDLE };
    }) as any;
    const res = await setUsername(srv.store, srv.httpJson, '@Kaios.42', undefined, entropy);
    assert.equal(res.username, 'Kaios.42');
    assert.equal(srv.calls[0].body.usernameHashes.length, 1);
    assert.deepEqual(res.entropy, entropy);
  });

  it('maps bad input and server refusals to readable errors', async () => {
    assert.throws(() => usernameCandidates('ab'), (e: any) => e.code === 'UsernameInvalid' && /at least 3/.test(e.message));
    assert.throws(() => usernameCandidates('1abc'), (e: any) => e.code === 'UsernameInvalid' && /start with a number/.test(e.message));
    assert.throws(() => usernameCandidates('kaios.0'), (e: any) => e.code === 'UsernameInvalid');
    const taken = usernameServer(409);
    await assert.rejects(setUsername(taken.store, taken.httpJson, 'kaios'), (e: any) => e.code === 'UsernameUnavailable');
    const lost = usernameServer(200, 410);
    await assert.rejects(setUsername(lost.store, lost.httpJson, 'kaios'), (e: any) => e.code === 'UsernameReservationLost');
    const limited = usernameServer(429);
    await assert.rejects(setUsername(limited.store, limited.httpJson, 'kaios'), (e: any) => e.code === 'UsernameRateLimited');
  });

  it('deletes with DELETE /v1/accounts/username_hash', async () => {
    const srv = usernameServer();
    await deleteUsername(srv.store, srv.httpJson);
    assert.deepEqual(srv.calls.map((c) => c.method + ' ' + c.path), ['DELETE /v1/accounts/username_hash']);
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

  it('turns pin, unpin, and timer-update data messages into normalize frames', () => {
    const env = { sourceUuid: BOB, sourceDevice: 1, timestamp: 1000 } as any;
    const frame = (dm: any) => contentToNormalizedFrame(env, create(ContentSchema, { content: { case: 'dataMessage', value: dm } })).envelope.dataMessage;
    const ref = { targetAuthorAciBinary: uuidToBytes(ALICE), targetSentTimestamp: 42n };
    assert.deepEqual(frame({ timestamp: 1000n, pinMessage: { ...ref, pinDuration: { case: 'pinDurationForever', value: true } } }).pinMessage, {
      targetAuthorUuid: ALICE,
      targetSentTimestamp: 42,
    });
    const unpin = frame({ timestamp: 1000n, unpinMessage: ref });
    assert.equal(unpin.pinMessage, undefined);
    assert.equal(unpin.unpinMessage.targetSentTimestamp, 42);
    const timer = frame({ timestamp: 1000n, flags: DataMessage_Flags.EXPIRATION_TIMER_UPDATE, expireTimer: 3600, expireTimerVersion: 3 });
    assert.equal(timer.expirationTimerUpdate, true);
    assert.equal(timer.expiresInSeconds, 3600);
    const quoted = frame({ timestamp: 1000n, body: 'nice', quote: { id: 7n, authorAci: ALICE, text: '', attachments: [{ contentType: 'image/jpeg', fileName: 'a.jpg' }] } });
    assert.deepEqual(quoted.quote, { id: 7, authorUuid: ALICE, text: '', attachments: [{ contentType: 'image/jpeg', filename: 'a.jpg' }] });
  });

  it('turns polls, votes, and poll ends into normalize frames within Signal-Desktop limits', () => {
    const env = { sourceUuid: BOB, sourceDevice: 1, timestamp: 1000 } as any;
    const frame = (dm: any) => contentToNormalizedFrame(env, create(ContentSchema, { content: { case: 'dataMessage', value: dm } })).envelope.dataMessage;
    assert.deepEqual(frame({ timestamp: 1000n, pollCreate: { question: 'Lunch?', options: ['Pizza', 'Soup'], allowMultiple: true } }).pollCreate, { question: 'Lunch?', options: ['Pizza', 'Soup'], allowMultiple: true });
    assert.equal(frame({ timestamp: 1000n, pollCreate: { question: 'Lunch?', options: ['Pizza'] } }).pollCreate, undefined);
    assert.equal(frame({ timestamp: 1000n, pollCreate: { question: 'x'.repeat(201), options: ['a', 'b'] } }).pollCreate, undefined);
    assert.ok(frame({ timestamp: 1000n, pollCreate: { question: '👋🏽'.repeat(200), options: ['a', 'b'] } }).pollCreate);
    assert.equal(frame({ timestamp: 1000n, pollCreate: { question: 'q', options: Array.from({ length: 11 }, (_, i) => 'o' + i) } }).pollCreate, undefined);
    assert.deepEqual(frame({ timestamp: 1000n, pollVote: { targetAuthorAciBinary: uuidToBytes(ALICE), targetSentTimestamp: 42n, optionIndexes: [1, 0], voteCount: 3 } }).pollVote, {
      targetAuthorUuid: ALICE,
      targetSentTimestamp: 42,
      optionIndexes: [1, 0],
      voteCount: 3,
    });
    assert.equal(frame({ timestamp: 1000n, pollVote: { targetAuthorAciBinary: uuidToBytes(ALICE), targetSentTimestamp: 42n, optionIndexes: [10], voteCount: 1 } }).pollVote, undefined);
    assert.deepEqual(frame({ timestamp: 1000n, pollTerminate: { targetSentTimestamp: 42n } }).pollTerminate, { targetSentTimestamp: 42 });
  });

  it('keeps a link preview only for a safe https link in the message text, as Signal-Desktop does', () => {
    const guid = '0f6c2a1e-4b7d-4c3a-9a8e-2d1f5b6c7e8f';
    const env = { sourceUuid: BOB, sourceDevice: 1, timestamp: 1000, serverGuid: guid.toUpperCase(), reportSpamToken: new Uint8Array([1, 2, 3]) } as any;
    const out = (dm: any) => contentToNormalizedFrame(env, create(ContentSchema, { content: { case: 'dataMessage', value: { timestamp: 1000n, ...dm } } })).envelope;
    const image = { attachmentIdentifier: { case: 'cdnKey' as const, value: 'k' }, cdnNumber: 2, key: new Uint8Array(64), contentType: 'image/jpeg', size: 1234 };
    const shown = out({ body: 'look (https://signal.org/blog/a?b=1).', preview: [{ url: 'https://signal.org/blog/a?b=1', title: 'Blog', description: 'Post', image }] });
    assert.equal(shown.serverGuid, guid);
    assert.equal(shown.reportSpamToken, 'AQID');
    const p = shown.dataMessage.preview;
    assert.deepEqual([p.url, p.title, p.description, p.image.contentType, p.image.size], ['https://signal.org/blog/a?b=1', 'Blog', 'Post', 'image/jpeg', 1234]);
    assert.ok(decodeAttachmentDescriptor(p.image.id));

    const dropped = (url: string, body = 'see ' + url) => assert.equal(out({ body, preview: [{ url, title: 'T' }] }).dataMessage.preview, undefined, url);
    dropped('https://signal.org/other', 'see https://signal.org/blog');
    dropped('http://signal.org/');
    dropped('https://user:pw@signal.org/');
    dropped('https://localhost/x');
    dropped('https://www.example.com/');
    dropped('https://xn--sgnal-m3a.org/');
    dropped('https://signal.org/aquí');
    dropped('https://signal.org/', 'see \u202ehttps://signal.org/');
    assert.equal(out({ body: 'https://signal.org/', preview: [{ url: 'https://signal.org/' }] }).dataMessage.preview, undefined);
    assert.equal(out({ body: 'hi' }).dataMessage.preview, undefined);
  });

  it('reports spam with POST /v1/messages/report/{aci}/{guid} and the reporting token', async () => {
    const calls: any[] = [];
    const httpJson = (async (method: string, path: string, body: any, opts: any) => {
      calls.push({ method, path, body, user: opts.basicAuth.username });
    }) as any;
    const store = new MemorySignalStore({ aci: ALICE, number: '', deviceId: 3, password: 'pw', registrationId: 1, pniRegistrationId: 2, aciIdentityKeyPair: { pubKey: new Uint8Array(33), privKey: new Uint8Array(32) } } as any);
    const g1 = '0f6c2a1e-4b7d-4c3a-9a8e-2d1f5b6c7e8f';
    const g2 = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
    assert.equal(await reportSpam(store, httpJson, BOB, [g1, 'not-a-guid', g2], 'AQID'), 2);
    assert.deepEqual(calls, [
      { method: 'POST', path: `/v1/messages/report/${BOB}/${g1}`, body: { token: 'AQID' }, user: ALICE + '.3' },
      { method: 'POST', path: `/v1/messages/report/${BOB}/${g2}`, body: { token: 'AQID' }, user: ALICE + '.3' },
    ]);
    calls.length = 0;
    await reportSpam(store, httpJson, BOB, [g1]);
    assert.deepEqual(calls[0].body, {});
    await assert.rejects(reportSpam(store, httpJson, 'PNI:' + BOB, [g1]));
  });

  it('reduces shared contacts to a name, numbers, and emails', () => {
    const env = { sourceUuid: BOB, sourceDevice: 1, timestamp: 1000 } as any;
    const dm = contentToNormalizedFrame(
      env,
      create(ContentSchema, {
        content: {
          case: 'dataMessage',
          value: {
            timestamp: 1000n,
            contact: [
              { name: { givenName: 'Clara', familyName: 'Oswald' }, number: [{ value: '+15550123' }, { value: '' }], email: [{ value: 'clara@example.com' }] },
              { organization: 'TARDIS Ltd' },
            ],
          },
        },
      })
    ).envelope.dataMessage;
    assert.deepEqual(dm.contacts, [
      { name: 'Clara Oswald', phones: ['+15550123'], emails: ['clara@example.com'] },
      { name: 'TARDIS Ltd', phones: [], emails: [] },
    ]);
  });

  it('turns viewed and view-once-open syncs into normalize frames', () => {
    const env = { sourceUuid: BOB, sourceDevice: 2, timestamp: 1000 } as any;
    const sync = contentToNormalizedFrame(
      env,
      create(ContentSchema, {
        content: {
          case: 'syncMessage',
          value: { viewed: [{ senderAciBinary: uuidToBytes(ALICE), timestamp: 5n }], content: { case: 'viewOnceOpen', value: { senderAci: ALICE, timestamp: 6n } } },
        },
      })
    ).envelope.syncMessage;
    assert.deepEqual(sync.viewedMessages, [{ sender: ALICE, senderUuid: ALICE, timestamp: 5 }]);
    assert.deepEqual(sync.viewOnceOpen, { sender: ALICE, senderUuid: ALICE, timestamp: 6 });
  });

  it('turns admin deletes and delete-for-me syncs into normalize frames', () => {
    const env = { sourceUuid: BOB, sourceDevice: 2, timestamp: 1000 } as any;
    const dm = contentToNormalizedFrame(
      env,
      create(ContentSchema, { content: { case: 'dataMessage', value: { timestamp: 1000n, adminDelete: { targetAuthorAciBinary: uuidToBytes(ALICE), targetSentTimestamp: 900n } } } })
    ).envelope.dataMessage;
    assert.deepEqual(dm.adminDelete, { targetAuthorUuid: ALICE, targetSentTimestamp: 900 });

    const groupId = new Uint8Array(32).fill(7);
    const sync = contentToNormalizedFrame(
      env,
      create(ContentSchema, {
        content: {
          case: 'syncMessage',
          value: {
            content: {
              case: 'deleteForMe',
              value: {
                messageDeletes: [{ conversation: { identifier: { case: 'threadServiceId', value: ALICE } }, messages: [{ author: { case: 'authorServiceIdBinary', value: uuidToBytes(ALICE) }, sentTimestamp: 5n }] }],
                conversationDeletes: [{ conversation: { identifier: { case: 'threadGroupId', value: groupId } }, mostRecentMessages: [{ author: { case: 'authorE164', value: '+15550001' }, sentTimestamp: 6n }], isFullDelete: true }],
                localOnlyConversationDeletes: [{ conversation: { identifier: { case: 'threadE164', value: '+15550002' } } }],
              },
            },
          },
        },
      })
    ).envelope.syncMessage;
    assert.deepEqual(sync.deleteForMe, {
      messages: [{ conversation: { uuid: ALICE }, messages: [{ author: ALICE, timestamp: 5 }] }],
      conversations: [
        { conversation: { groupId: toBase64(groupId) }, mostRecent: [{ author: '+15550001', timestamp: 6 }], mostRecentNonExpiring: [], isFullDelete: true },
        { conversation: { number: '+15550002' }, mostRecent: [], mostRecentNonExpiring: [], isFullDelete: true },
      ],
    });
  });

  it('turns message request responses into normalize frames', () => {
    const env = { sourceUuid: BOB, sourceDevice: 2, timestamp: 1000 } as any;
    const frame = (value: any) => contentToNormalizedFrame(env, create(ContentSchema, { content: { case: 'syncMessage', value: { content: { case: 'messageRequestResponse', value } } } })).envelope.syncMessage.messageRequestResponse;
    assert.deepEqual(frame({ threadAciBinary: uuidToBytes(ALICE), type: SyncMessage_MessageRequestResponse_Type.BLOCK_AND_DELETE }), { threadUuid: ALICE, groupId: undefined, type: 'blockAndDelete' });
    assert.deepEqual(frame({ threadAci: ALICE, type: SyncMessage_MessageRequestResponse_Type.ACCEPT }), { threadUuid: ALICE, groupId: undefined, type: 'accept' });
    assert.equal(frame({ threadAci: ALICE }).type, 'unknown');
  });

  it('reads service IDs from strings or 16/17-byte binaries', () => {
    const raw = uuidToBytes(ALICE);
    assert.equal(serviceIdFrom(undefined, raw), ALICE);
    assert.equal(serviceIdFrom(undefined, concatBytes(new Uint8Array([1]), raw)), 'PNI:' + ALICE);
    assert.equal(serviceIdFrom('PNI:x', raw), 'PNI:x');
    assert.equal(serviceIdFrom(undefined, new Uint8Array(5)), '');
  });
});
