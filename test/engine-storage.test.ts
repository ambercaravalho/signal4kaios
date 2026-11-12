import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes, toBase64, toHex } from '../src/engine/bytes';
import { joinedGroupMutation } from '../src/engine/services/group-changes';
import {
  AccountRecord_PhoneNumberSharingMode,
  ContactRecord_NameSchema,
  ManifestRecord_Identifier_Type,
  NotificationProfile_DayOfWeek,
  NotificationProfileSchema,
  StorageRecordSchema,
} from '../src/engine/gen/SignalStorage_pb';
import { adoptOwnProfileKey } from '../src/engine/services/profiles';
import { create, fromBinary } from '../src/engine/net/proto';
import { mutateStorage, pullFromStorageService, setPhoneNumberPrivacy, StorageWriteQueue, toOptionalBool } from '../src/engine/services/storage';
import { profileOverrideRecord, readNotificationProfile, readProfileOverride } from '../src/engine/services/storage/notification-profiles';
import { groupIdFromMasterKey } from '../src/engine/services/groups-v2';
import { MemorySignalStore } from '../src/engine/protocol/store';
import { ALICE, BOB } from './helpers';
import { hasBytes, serveStorage, storageStore, UNKNOWN_FIELD } from './storage-fixture';
import { loadWasmForTests } from './support';

before(() => {
  loadWasmForTests();
});

describe('Storage Service (Signal-Desktop key derivation)', () => {
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
      assert.deepEqual(res.stickerPacks, [{ id: toHex(srv.stickerPackId), key: toHex(srv.stickerPackKey), position: 3 }]);

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
      assert.equal(after.length, 6);
      assert.ok(after.includes(toBase64(srv.unknownKey)), 'unknown record types stay in the manifest');
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

  it('reads and writes notification settings, timed mutes, and the notification profile switch', async () => {
    const masterKey = randomBytes(32);
    const store = storageStore(masterKey);
    const srv = await serveStorage(masterKey);
    const first = await pullFromStorageService(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org');
    assert.equal(first!.account?.reactionNotifications, true);
    assert.equal(first!.account?.notifyForRepliesIfMuted, true);
    assert.equal(first!.account?.notifyForCallsIfMuted, false);
    assert.equal(first!.account?.notificationProfileOverride, null);
    assert.equal(first!.groupsV2[0].notifyForCallsIfMuted, undefined);

    const until = Date.now() + 3600000;
    await mutateStorage(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org', [
      { type: 'account', update: (a) => { a.reactionNotifications = toOptionalBool(false); a.notifyForCallsIfMuted = toOptionalBool(true); a.notificationProfileManualOverride = profileOverrideRecord({ enabledId: 'c2xlZXA=', endAt: until }); } },
      { type: 'groupV2', masterKey: srv.groupMasterKey, update: (g) => { g.notifyForRepliesIfMuted = toOptionalBool(false); g.notifyForCallsIfMuted = toOptionalBool(true); g.mutedUntilTimestamp = BigInt(until); } },
    ]);
    const res = await pullFromStorageService(store, srv.httpJson as any, srv.httpBinary, 'https://chat.signal.org');
    assert.equal(res!.account?.reactionNotifications, false);
    assert.equal(res!.account?.notifyForCallsIfMuted, true);
    assert.deepEqual(res!.account?.notificationProfileOverride, { enabledId: 'c2xlZXA=', endAt: until });
    assert.equal(res!.groupsV2[0].notifyForRepliesIfMuted, false);
    assert.equal(res!.groupsV2[0].notifyForCallsIfMuted, true);
    assert.equal(res!.groupsV2[0].mutedUntilTimestamp, until);
    assert.deepEqual(readProfileOverride(profileOverrideRecord({ disabledAt: 42 })), { disabledAt: 42 });
  });

  it('reads notification profiles from the phone and skips deleted ones', () => {
    const groupKey = randomBytes(32);
    const profile = create(NotificationProfileSchema, {
      id: new Uint8Array([1, 2, 3]),
      name: 'Sleep',
      emoji: '🌙',
      allowAllCalls: true,
      allowedMembers: [{ identifier: { case: 'contact', value: { serviceId: ALICE, e164: '+15550001111' } } }, { identifier: { case: 'groupMasterKey', value: groupKey } }],
      scheduleEnabled: true,
      scheduleStartTime: 2200,
      scheduleEndTime: 700,
      scheduleDaysEnabled: [NotificationProfile_DayOfWeek.UNKNOWN, NotificationProfile_DayOfWeek.SUNDAY],
    });
    const p = readNotificationProfile(profile)!;
    assert.equal(p.id, toBase64(new Uint8Array([1, 2, 3])));
    assert.deepEqual(p.allowed, [ALICE, '+15550001111', 'g:' + groupIdFromMasterKey(groupKey)]);
    assert.deepEqual(p.schedule, { start: 2200, end: 700, days: [1, 7] });
    assert.equal(p.allowAllCalls, true);
    profile.deletedAtTimestampMs = 5n;
    assert.equal(readNotificationProfile(profile), null);
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
