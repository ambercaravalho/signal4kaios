import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes, toBase64 } from '../src/engine/bytes';
import { accountMethods } from '../src/engine/bridge/account';
import { contactMethods } from '../src/engine/bridge/contact-actions';
import { contactIds, recordPeerProfileKey, syncedContacts, syncedGroups } from '../src/engine/bridge/contacts';
import { mergeGroupState } from '../src/engine/bridge/group-state';
import { client, httpJson, storageQueue, store } from '../src/engine/bridge/context';
import { conversationIdentifier } from '../src/engine/bridge/delivery';
import { incomingMethods } from '../src/engine/bridge/incoming';
import { outgoingMethods } from '../src/engine/bridge/outgoing';
import { resetPeerNamesForTest } from '../src/engine/bridge/peer-names';
import { ContentSchema } from '../src/engine/gen/SignalService_pb';
import { type EngineHost, setEngineHost } from '../src/engine/host';
import { create } from '../src/engine/net/proto';
import { libsignal } from '../src/engine/protocol/libsignal';
import { loadPreKeyRotation, PRE_KEY_ROTATION_MS } from '../src/engine/protocol/prekeys';
import { identityRecord, safetyNumber, saveIdentityKey, saveOwnIdentityKey, setIdentityTrust } from '../src/engine/protocol/protocol';
import { deriveGroupV2Keys } from '../src/engine/services/groups-v2';
import { encryptProfileName, fetchAndDecryptProfile } from '../src/engine/services/profiles';
import { ALICE, BOB, settle } from './helpers';
import { loadWasmForTests } from './support';

const ME_NUMBER = '+15550009999';
const CAROL = '33333333-3333-4333-8333-333333333333';

const kv = new Map<string, any>();
const keys = new Map<string, any>();
const identities = new Map<string, any>();
const preKeys = new Map<string, any>();
const gets: string[] = [];
let directoryChanges = 0;
let profiles: Record<string, string> = {};
let profileKeys: Record<string, string> = {};
const ingested: any[] = [];

const fakeHost = {
  http: {
    async request(method: string, path: string) {
      if (method !== 'GET' || !path.startsWith('/v1/profile/')) throw Object.assign(new Error('HTTP 404'), { status: 404 });
      gets.push(path);
      const aci = decodeURIComponent(path.split('/')[3]);
      return { ...(profiles[aci] ? { name: profiles[aci] } : {}), ...(profileKeys[aci] ? { identityKey: profileKeys[aci] } : {}) };
    },
    rawBinary: async () => new Uint8Array(0),
    rawRequest: async () => ({ status: 404, body: new Uint8Array(0), location: null }),
  },
  db: {
    kvGet: async (k: string) => kv.get(k),
    kvSet: async (k: string, v: unknown) => void kv.set(k, JSON.parse(JSON.stringify(v))),
    getAttachment: async () => undefined,
    putAttachment: async () => {},
    signalKeyGet: async (k: string) => keys.get(k),
    signalKeySet: async (k: string, v: unknown) => void keys.set(k, v),
    getPreKey: async (k: string) => preKeys.get(k),
    putPreKey: async (k: string, v: unknown) => void preKeys.set(k, v),
    deletePreKey: async (k: string) => void preKeys.delete(k),
    putIdentity: async (rec: any) => void identities.set(rec.address, { ...rec }),
    getIdentity: async (a: string) => (identities.has(a) ? { ...identities.get(a) } : undefined),
    deleteIdentity: async (a: string) => void identities.delete(a),
    allIdentities: async () => [...identities.values()].map((r) => ({ ...r })),
  },
  config: { serverUrl: () => '', aci: () => ALICE, profileName: () => '', sharePhoneNumber: () => false, stickerPacks: () => [], set: () => {} },
  dbg: () => {},
  directoryChanged: async () => {
    directoryChanges++;
  },
  applyChatState: () => {},
  ingest: (frame: any) => void ingested.push(frame),
  numberChanged: () => {},
} as unknown as EngineHost;

before(async () => {
  loadWasmForTests();
  setEngineHost(fakeHost);
  const kp = libsignal.keyPairGenerate() as { publicKey: Uint8Array; privateKey: Uint8Array };
  await store.saveAccount({ aci: ALICE, number: ME_NUMBER, deviceId: 2, password: 'test-only', registrationId: 1, pniRegistrationId: 2, aciIdentityKeyPair: { pubKey: kp.publicKey, privKey: kp.privateKey } });
});

beforeEach(() => {
  kv.clear();
  gets.length = 0;
  directoryChanges = 0;
  profiles = {};
  profileKeys = {};
  ingested.length = 0;
  resetPeerNamesForTest();
});

describe('names for people we only know from their messages', () => {
  it('fetches the profile once when the key arrives and refreshes the directory once', async () => {
    const key = randomBytes(32);
    profiles[BOB] = await encryptProfileName('Bea', 'Ortiz', key);
    await recordPeerProfileKey(BOB, undefined, key);
    await recordPeerProfileKey(BOB, undefined, key);
    await settle();
    assert.equal(gets.length, 1);
    assert.ok(gets[0].startsWith('/v1/profile/' + BOB + '/'), 'asks with the profile key version');
    const row = (await syncedContacts()).find((c) => c.uuid === BOB)!;
    assert.equal(row.profile_name, 'Bea Ortiz');
    assert.equal(directoryChanges, 1);
  });

  it('leaves the directory alone when the profile has no name', async () => {
    await recordPeerProfileKey(CAROL, undefined, randomBytes(32));
    await settle();
    assert.equal(gets.length, 1);
    assert.equal(directoryChanges, 0);
  });

  it('saves the profile name when the avatar lookup reads the profile', async () => {
    const key = randomBytes(32);
    profiles[CAROL] = await encryptProfileName('Cara', '', key);
    kv.set('syncedContacts', [{ uuid: CAROL, number: '', name: CAROL, blocked: false, expireTimer: 0 }]);
    client.setPeerProfileKey(CAROL, key);
    await assert.rejects(contactMethods.fetchContactAvatarBlob(CAROL), /No profile avatar/);
    assert.equal((await syncedContacts())[0].profile_name, 'Cara');
    assert.equal(directoryChanges, 1);
  });
});

describe('our own number', () => {
  it('resolves to our ACI, so backfill requests name Note to Self by ACI', async () => {
    assert.deepEqual(await contactIds(ME_NUMBER), { aci: ALICE, e164: ME_NUMBER });
    const id = await conversationIdentifier(ME_NUMBER);
    assert.deepEqual(id && id.identifier, { case: 'threadServiceId', value: ALICE });
  });
});

describe('safety numbers', () => {
  it('computes one contact at a time, cached until their key changes', async () => {
    const other = libsignal.keyPairGenerate() as { publicKey: Uint8Array };
    await store.saveIdentity(BOB, other.publicKey, { uuid: BOB });
    await store.saveIdentity(CAROL, (libsignal.keyPairGenerate() as { publicKey: Uint8Array }).publicKey, { uuid: CAROL });
    const cache = (client as any).safetyNumbers as Map<string, unknown>;
    cache.clear();

    const first = (await client.safetyNumberFor(BOB))!;
    assert.match(first.safety_number, /^\d{60}$/);
    assert.equal(first.uuid, BOB);
    assert.ok(first.scannable_safety_number);
    assert.equal(cache.size, 1, 'other contacts are not computed');
    assert.deepEqual(await client.safetyNumberFor(BOB), first);
    assert.equal(cache.size, 1);

    await store.saveIdentity(BOB, (libsignal.keyPairGenerate() as { publicKey: Uint8Array }).publicKey, { uuid: BOB });
    const next = (await client.safetyNumberFor(BOB))!;
    assert.notEqual(next.safety_number, first.safety_number);
    assert.equal(cache.size, 2);

    assert.equal(await client.safetyNumberFor(ALICE), null, 'none for ourselves');
    assert.equal(await contactMethods.safetyNumber('+15550004444'), null, 'none for an unknown number');
  });

  it('matches a scanned code from the official apps (raw bytes) and from older Beacons (base64)', () => {
    const a = libsignal.keyPairGenerate() as { publicKey: Uint8Array };
    const b = libsignal.keyPairGenerate() as { publicKey: Uint8Array };
    const ours = safetyNumber(ALICE, a.publicKey, BOB, b.publicKey);
    const theirs = safetyNumber(BOB, b.publicKey, ALICE, a.publicKey);
    const verify = (scanned: string) => contactMethods.verifySafetyNumberQr(scanned, toBase64(ours.scannable), ours.safetyNumber);
    assert.equal(verify(String.fromCharCode(...theirs.scannable)), true, 'Latin-1, as the scanner reads Signal’s byte-mode code');
    assert.equal(verify(toBase64(theirs.scannable)), true, 'base64, as Beacon before 2.10.3 showed it');
    assert.equal(verify(new TextDecoder().decode(theirs.scannable)), false, 'bytes mangled by a UTF-8 decode');
    assert.equal(verify(String.fromCharCode(...ours.scannable)), false, 'our own code');
  });
});

describe('identity key changes', () => {
  const newKey = () => (libsignal.keyPairGenerate() as { publicKey: Uint8Array }).publicKey;
  const notices = () => ingested.filter((f) => f.envelope && f.envelope.notice && f.envelope.notice.kind === 'safetyNumber');
  beforeEach(() => identities.clear());

  it('adds one safety number notice when a profile lookup brings a new key, and none when it repeats', async () => {
    kv.set('syncedContacts', [{ uuid: BOB, number: '+15550001111', name: 'Bob', blocked: false, expireTimer: 0 }]);
    await saveIdentityKey(store, BOB, newKey(), { uuid: BOB });
    await settle();
    assert.equal(notices().length, 0, 'the first key is not a change');
    const second = newKey();
    profileKeys[BOB] = toBase64(second);
    await fetchAndDecryptProfile(store, httpJson, BOB);
    await settle();
    assert.equal(notices().length, 1);
    assert.equal(notices()[0].envelope.sourceUuid, BOB);
    assert.equal(notices()[0].envelope.sourceNumber, '+15550001111', 'names the chat by number, as incoming messages do');
    await fetchAndDecryptProfile(store, httpJson, BOB);
    await settle();
    assert.equal(notices().length, 1, 'the same key again changes nothing');
  });

  it('adds one notice when a send fetches a bundle with a changed key, including a refused change to a verified key', async () => {
    await saveIdentityKey(store, CAROL, newKey(), { uuid: CAROL });
    await (client as any).acceptBundleIdentity(CAROL, newKey());
    await settle();
    assert.equal(notices().length, 1);
    await setIdentityTrust(store, CAROL, 'TRUSTED_VERIFIED');
    const verified = (await identityRecord(store, CAROL))!.publicKey;
    await assert.rejects((client as any).acceptBundleIdentity(CAROL, newKey()));
    await settle();
    assert.equal(notices().length, 2);
    assert.deepEqual((await identityRecord(store, CAROL))!.publicKey, verified, 'the verified key is kept');
    assert.equal((await identityRecord(store, CAROL))!.trustLevel, 'UNTRUSTED');
  });

  it('never reports our own keys', async () => {
    await saveIdentityKey(store, ALICE, newKey(), { uuid: ALICE });
    await saveIdentityKey(store, ALICE, newKey(), { uuid: ALICE });
    await saveOwnIdentityKey(store, 'PNI:' + CAROL, newKey());
    await saveOwnIdentityKey(store, 'PNI:' + CAROL, newKey());
    await settle();
    assert.equal(notices().length, 0);
  });
});

describe('PreKey upkeep', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const realRequest = fakeHost.http.request;
  let counts = { count: 100, pqCount: 100 };
  let puts: any[] = [];

  beforeEach(() => {
    preKeys.clear();
    puts = [];
    counts = { count: 100, pqCount: 100 };
    (fakeHost.http as any).request = async (method: string, path: string, body: any) => {
      if (path !== '/v2/keys?identity=aci') return (realRequest as any).call(fakeHost.http, method, path);
      if (method === 'GET') return counts;
      puts.push(body);
      return {};
    };
  });

  after(() => {
    (fakeHost.http as any).request = realRequest;
  });

  const rotated = (daysAgo: number, signed: Array<[number, number]> = [], lastResort: Array<[number, number]> = []) =>
    store.storeValue('preKeyRotation:aci', {
      rotatedAt: Date.now() - daysAgo * DAY,
      signed: signed.map(([id, d]) => ({ id, at: Date.now() - d * DAY })),
      lastResort: lastResort.map(([id, d]) => ({ id, at: Date.now() - d * DAY })),
    });

  it('uploads only one-time keys when the server runs low', async () => {
    await rotated(1);
    counts = { count: 4, pqCount: 9 };
    await accountMethods.maintainPreKeys();
    assert.equal(puts.length, 1);
    assert.deepEqual(Object.keys(puts[0]).sort(), ['pqPreKeys', 'preKeys']);
    assert.equal(puts[0].preKeys.length, 100);
    assert.equal(puts[0].pqPreKeys.length, 100);
  });

  it('rotates a signed key that is three days old', async () => {
    await rotated(3);
    await accountMethods.maintainPreKeys();
    assert.equal(puts.length, 1);
    assert.deepEqual(Object.keys(puts[0]).sort(), ['pqLastResortPreKey', 'signedPreKey']);
    const rotation = await loadPreKeyRotation(store, 'aci');
    assert.ok(Date.now() - rotation.rotatedAt < PRE_KEY_ROTATION_MS);
    assert.equal(rotation.signed[rotation.signed.length - 1].id, puts[0].signedPreKey.keyId);
    assert.ok(await store.loadSignedPreKey(puts[0].signedPreKey.keyId));
  });

  it('uploads nothing while the keys are fresh and plentiful', async () => {
    await rotated(1);
    await accountMethods.maintainPreKeys();
    assert.equal(puts.length, 0);
  });

  it('deletes old signed and last-resort keys beyond the newest three', async () => {
    const record = new Uint8Array([1]);
    for (const id of [1, 2, 3, 4]) {
      await store.storeSignedPreKey(id, record);
      await store.storeKyberPreKey(100 + id, record, true);
    }
    await rotated(3, [[1, 50], [2, 40], [3, 35], [4, 3]], [[101, 50], [102, 40], [103, 35], [104, 3]]);
    await accountMethods.maintainPreKeys();
    const rotation = await loadPreKeyRotation(store, 'aci');
    assert.deepEqual(rotation.signed.map((k) => k.id).slice(0, 2), [3, 4]);
    assert.equal(rotation.signed.length, 3);
    assert.deepEqual(rotation.lastResort.map((k) => k.id).slice(0, 2), [103, 104]);
    assert.equal(await store.loadSignedPreKey(1), null);
    assert.equal(await store.loadSignedPreKey(2), null);
    assert.ok(await store.loadSignedPreKey(3), 'one of the newest three, even though it is old');
    assert.equal(await store.loadKyberPreKey(101), null);
    assert.equal(await store.loadKyberPreKey(102), null);
    assert.ok(await store.loadKyberPreKey(104));
  });

  it('keeps keys younger than 30 days even beyond the newest three', async () => {
    const record = new Uint8Array([1]);
    for (const id of [5, 6, 7, 8]) await store.storeSignedPreKey(id, record);
    await rotated(3, [[5, 20], [6, 10], [7, 5], [8, 3]]);
    await accountMethods.maintainPreKeys();
    assert.equal((await loadPreKeyRotation(store, 'aci')).signed.length, 5);
    assert.ok(await store.loadSignedPreKey(5));
  });
});

describe('group messages from people who are not members', () => {
  const masterKey = new Uint8Array(32).fill(7);
  const realDecrypt = (client as any).enqueueDecryptEnvelope;

  beforeEach(() => {
    const keys = deriveGroupV2Keys(masterKey);
    kv.set('syncedGroups', [{ id: keys.sendId, internal_id: keys.internalId, masterKey: toBase64(masterKey), revision: 5, name: 'Book club', members: [ALICE, BOB], admins: [], blocked: false }]);
  });

  after(() => {
    (client as any).enqueueDecryptEnvelope = realDecrypt;
  });

  function receive(sender: string, value: Record<string, unknown>) {
    const frame = { envelope: { sourceUuid: sender, timestamp: 1000 } };
    (client as any).enqueueDecryptEnvelope = async () => ({
      envelope: { sourceUuid: sender, sourceDevice: 1, timestamp: 1000 },
      content: create(ContentSchema, { content: { case: 'dataMessage', value } }),
      normalizedFrame: frame,
    });
    return incomingMethods.processIncomingEnvelope(new Uint8Array(1)).then((res) => res === frame);
  }

  it('drops a message from a non-member at our revision', async () => {
    assert.equal(await receive(CAROL, { body: 'hi', timestamp: 1000n, groupV2: { masterKey, revision: 5 } }), false);
  });

  it('keeps it when the message names a newer revision, since our copy may be behind', async () => {
    assert.equal(await receive(CAROL, { body: 'hi', timestamp: 1000n, groupV2: { masterKey, revision: 6 } }), true);
  });

  it('keeps a member’s message', async () => {
    assert.equal(await receive(BOB, { body: 'hi', timestamp: 1000n, groupV2: { masterKey, revision: 5 } }), true);
  });

  it('drops a reaction from a non-member', async () => {
    const reaction = { emoji: '\u{1F44D}', targetAuthorAci: BOB, targetSentTimestamp: 900n };
    assert.equal(await receive(CAROL, { reaction, timestamp: 1000n, groupV2: { masterKey, revision: 5 } }), false);
  });

  it('keeps a message that carries a group change, which is how a new member’s first message arrives', async () => {
    assert.equal(await receive(CAROL, { body: 'hi', timestamp: 1000n, groupV2: { masterKey, revision: 5, groupChange: new Uint8Array([1]) } }), true);
  });
});

describe('read receipts', () => {
  it('tells our other devices what we read even with read receipts off', async () => {
    const sent: string[] = [];
    const c = client as any;
    const { sendContentToRecipient, sendSyncMessage } = c;
    c.sendContentToRecipient = async (to: string, content: any) => void sent.push('receipt ' + to + ' ' + content.content.case);
    c.sendSyncMessage = async (content: any) => void sent.push('sync ' + content.content.value.read.map((r: any) => r.senderAci + ' ' + r.timestamp).join());
    try {
      await outgoingMethods.sendReadReceipt(BOB, 1000, { receipt: false });
      assert.deepEqual(sent, ['sync ' + BOB + ' 1000']);
      sent.length = 0;
      await outgoingMethods.sendReadReceipt(BOB, 2000, { receipt: true });
      assert.deepEqual(sent, ['receipt ' + BOB + ' receiptMessage', 'sync ' + BOB + ' 2000']);
    } finally {
      c.sendContentToRecipient = sendContentToRecipient;
      c.sendSyncMessage = sendSyncMessage;
    }
  });
});

describe('unlinking', () => {
  it('removes this device from the account with its own credentials', async () => {
    const calls: any[] = [];
    const http = fakeHost.http as any;
    const request = http.request;
    http.request = async (method: string, path: string, _body: unknown, opts: any) => {
      calls.push([method, path, opts.basicAuth && opts.basicAuth.username]);
      return {};
    };
    try {
      await accountMethods.unlinkThisDevice();
    } finally {
      http.request = request;
    }
    assert.deepEqual(calls, [['DELETE', '/v1/devices/2', ALICE + '.2']]);
  });
});

describe('group invites', () => {
  const masterKey = new Uint8Array(32).fill(9);
  const gk = deriveGroupV2Keys(masterKey);
  const state = (members: string[], pending: string[]) => ({ id: gk.sendId, internal_id: gk.internalId, masterKey: toBase64(masterKey), revision: 2, name: 'Picnic', members, admins: [BOB], pending, expireTimer: 0, blocked: false, link_mode: 'disabled' as const, invite_link: '', invitedBy: { [ALICE]: BOB } });

  it('waits for Accept when a contact invited us, and stops once we are a member', async () => {
    kv.set('syncedContacts', [{ uuid: BOB, number: '+15550002', name: 'Bob', whitelisted: true, systemContact: true }]);
    kv.set('syncedGroups', [{ id: gk.sendId, internal_id: gk.internalId, masterKey: toBase64(masterKey), revision: 1, name: 'Group', members: [BOB], admins: [], blocked: false, unvetted: true }]);
    await mergeGroupState(state([BOB], [ALICE]));
    let row = (await syncedGroups()).find((g) => g.internal_id === gk.internalId)!;
    assert.equal(row.messageRequest, true);
    assert.equal(row.pendingInvite, true);

    await mergeGroupState({ ...state([BOB, ALICE], []), revision: 3 });
    row = (await syncedGroups()).find((g) => g.internal_id === gk.internalId)!;
    assert.equal(row.messageRequest, undefined, 'accepted, maybe on another device');
    assert.equal(row.pendingInvite, undefined);
  });

  it('opens as usual when a contact added us outright', async () => {
    kv.set('syncedContacts', [{ uuid: BOB, number: '+15550002', name: 'Bob', whitelisted: true, systemContact: true }]);
    kv.set('syncedGroups', [{ id: gk.sendId, internal_id: gk.internalId, masterKey: toBase64(masterKey), revision: 1, name: 'Group', members: [BOB], admins: [], blocked: false, unvetted: true }]);
    await mergeGroupState({ ...state([BOB, ALICE], []), invitedBy: {} }, { author: BOB, revision: 2, timestamp: 1 });
    assert.equal((await syncedGroups())[0].messageRequest, undefined);
  });
});

describe('numbers for people who write by ACI', () => {
  const realDecrypt = (client as any).enqueueDecryptEnvelope;

  after(() => {
    (client as any).enqueueDecryptEnvelope = realDecrypt;
  });

  function receive(frameEnv: any, content: any) {
    (client as any).enqueueDecryptEnvelope = async () => ({ envelope: { sourceUuid: frameEnv.sourceUuid, sourceDevice: 1, timestamp: 1000 }, content, normalizedFrame: { envelope: frameEnv } });
    return incomingMethods.processIncomingEnvelope(new Uint8Array(1));
  }

  it('adds the number our contacts know to an identified message and to a synced send', async () => {
    kv.set('syncedContacts', [{ uuid: BOB, number: '+15550002', name: 'Bob' }]);
    const msg = await receive({ sourceUuid: BOB, timestamp: 1000 }, create(ContentSchema, { content: { case: 'dataMessage', value: { body: 'hi', timestamp: 1000n } } }));
    assert.equal(msg!.envelope.sourceNumber, '+15550002');

    const sync = await receive({ sourceUuid: ALICE, timestamp: 1000, syncMessage: { sentMessage: { destinationUuid: BOB, timestamp: 1000, message: 'yo' } } }, create(ContentSchema, { content: { case: 'syncMessage', value: {} } }));
    assert.equal(sync!.envelope.syncMessage.sentMessage.destinationNumber, '+15550002');
  });

  it('leaves someone without a known number keyed by ACI', async () => {
    const msg = await receive({ sourceUuid: CAROL, timestamp: 1000 }, create(ContentSchema, { content: { case: 'dataMessage', value: { body: 'hi', timestamp: 1000n } } }));
    assert.equal(msg!.envelope.sourceNumber, undefined);
  });
});

describe('saved Storage Service writes', () => {
  const q = storageQueue as any;
  const realWrite = q.write;

  after(() => {
    q.write = realWrite;
  });

  it('keeps a setting change that could not be written and makes it again later', async () => {
    q.write = async () => {
      throw new Error('offline');
    };
    const change = accountMethods.setReadReceipts(false);
    await accountMethods.flushStorageWrites().catch(() => {});
    await change.catch(() => {});
    await settle();
    assert.deepEqual(kv.get('pendingStorageWrites').map((r: any) => [r.method, r.args]), [['accountToggle', ['readReceipts', false]]]);

    const record: any = { readReceipts: true };
    q.write = async (muts: any[]) => {
      for (const m of muts) m.update(record);
      return false;
    };
    await accountMethods.replayStorageWrites();
    await settle();
    assert.equal(record.readReceipts, false);
    assert.deepEqual(kv.get('pendingStorageWrites'), []);
  });
});

describe('our own profile', () => {
  const q = storageQueue as any;
  const realWrite = q.write;
  const http = fakeHost.http as any;
  const realRequest = http.request;
  const cfg = fakeHost.config as any;
  const realSet = cfg.set;
  let original: any;

  before(async () => {
    original = await store.getAccount();
    await store.saveAccount({ ...original, profileKey: randomBytes(32) });
  });

  after(async () => {
    q.write = realWrite;
    http.request = realRequest;
    cfg.set = realSet;
    await store.saveAccount(original);
  });

  it('writes a new name to the account record, keeps About, and loads both back', async () => {
    let profile: any = {};
    http.request = async (method: string, path: string, body: any) => {
      if (method === 'GET' && path.startsWith('/v1/profile/')) return profile;
      if (method === 'PUT' && path === '/v1/profile') profile = { name: body.name, about: body.about, aboutEmoji: body.aboutEmoji };
      return {};
    };
    const record: any = { givenName: 'Old', familyName: '' };
    q.write = async (muts: any[]) => {
      for (const m of muts) m.update(record);
      return false;
    };
    await accountMethods.updateOwnProfile({ name: 'Ann Lee', about: 'Gardening' });
    await accountMethods.flushStorageWrites();
    assert.deepEqual([record.givenName, record.familyName], ['Ann', 'Lee']);

    await accountMethods.updateOwnProfile({ name: 'Ann Lea' });
    await accountMethods.flushStorageWrites();
    assert.equal(record.familyName, 'Lea');

    const patches: any[] = [];
    cfg.set = (p: any) => void patches.push(p);
    await accountMethods.hydrateOwnProfile();
    assert.deepEqual(patches, [{ profileName: 'Ann Lea', profileAbout: 'Gardening', profileAboutEmoji: '' }]);
  });
});
