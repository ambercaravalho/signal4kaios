import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as official from '@signalapp/libsignal-client';
import * as zk from '@signalapp/libsignal-client/zkgroup';

import { concatBytes, fromBase64, fromHex, randomBytes, toBase64, toHex, uuidToBytes } from '../engine/bytes';
import { attachmentPaddedSize, decryptAttachment, encryptAttachment } from '../engine/crypto/attachment';
import { aesGcmEncrypt } from '../engine/crypto/primitives';
import { ContactDetailsSchema, ContentSchema, DataMessage_Flags } from '../engine/gen/SignalService_pb';
import {
  AccessControl_AccessRequired,
  GroupAttributeBlobSchema,
  GroupChange_ActionsSchema,
  GroupChangeResponseSchema,
  GroupChangeSchema,
  GroupInviteLinkSchema,
  GroupResponseSchema,
  GroupSchema,
  Member_Role,
} from '../engine/gen/Groups_pb';
import {
  addMembersActions,
  applyGroupChange,
  inviteLinkActions,
  leaveActions,
  permissionActions,
  removeMembersActions,
  roleActions,
  snapshotGroup,
  titleActions,
} from '../engine/services/group-changes';
import {
  ContactRecord_NameSchema,
  ContactRecordSchema,
  ManifestRecord_Identifier_Type,
  ManifestRecordSchema,
  ReadOperationSchema,
  StorageItemsSchema,
  StorageManifestSchema,
  StorageRecordSchema,
  WriteOperationSchema,
} from '../engine/gen/SignalStorage_pb';
import { decodeGroupState, deriveGroupV2Keys, groupIdFromMasterKey } from '../engine/services/groups-v2';
import { libsignal } from '../engine/protocol/libsignal';
import { decryptProfile, decryptProfileName, encryptProfileName } from '../engine/services/profiles';
import { create, fromBinary, serviceIdFrom, toBinary } from '../engine/net/proto';
import {
  decryptStorageValue,
  deriveStorageItemKey,
  deriveStorageManifestKey,
  deriveStorageServiceKey,
  mutateStorage,
  pullFromStorageService,
  StorageWriteQueue,
} from '../engine/services/storage-service';
import { MemorySignalStore } from '../engine/protocol/store';
import { deleteUsername, setUsername, usernameCandidates, usernameLinkUrl } from '../engine/services/usernames';
import { loadWasmForTests } from './support';
import { contentToNormalizedFrame, parseContactsSyncBlob } from '../engine/net/receive';

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
      create(ContactRecordSchema, { aci: ALICE, e164: '+15553334444', givenName: 'Clara', familyName: 'Oswald', profileKey, blocked: true })
    );
    await putRaw(contactKey, rawContactRecord(concatBytes(contactBytes, UNKNOWN_FIELD)));
    await put(groupKey, { case: 'groupV2', value: { masterKey: groupMasterKey, archived: true } });
    await put(accountKey, { case: 'account', value: { givenName: 'Me', readReceipts: true } });
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
      assert.deepEqual(res.contacts[0].profileKey, srv.profileKey);
      assert.deepEqual(res.groupsV2[0].masterKey, srv.groupMasterKey);
      assert.equal(res.groupsV2[0].archived, true);
      assert.equal(res.account?.givenName, 'Me');
      assert.equal(res.account?.readReceipts, true);

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
        { type: 'account', update: (a) => { a.username = 'clara.42'; } },
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
    });
  }

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
  });

  it('reads service IDs from strings or 16/17-byte binaries', () => {
    const raw = uuidToBytes(ALICE);
    assert.equal(serviceIdFrom(undefined, raw), ALICE);
    assert.equal(serviceIdFrom(undefined, concatBytes(new Uint8Array([1]), raw)), 'PNI:' + ALICE);
    assert.equal(serviceIdFrom('PNI:x', raw), 'PNI:x');
    assert.equal(serviceIdFrom(undefined, new Uint8Array(5)), '');
  });
});
