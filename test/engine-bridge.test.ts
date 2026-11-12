import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from '../src/engine/bytes';
import { contactMethods } from '../src/engine/bridge/contact-actions';
import { contactIds, recordPeerProfileKey, syncedContacts } from '../src/engine/bridge/contacts';
import { client, store } from '../src/engine/bridge/context';
import { conversationIdentifier } from '../src/engine/bridge/delivery';
import { resetPeerNamesForTest } from '../src/engine/bridge/peer-names';
import { type EngineHost, setEngineHost } from '../src/engine/host';
import { libsignal } from '../src/engine/protocol/libsignal';
import { encryptProfileName } from '../src/engine/services/profiles';
import { ALICE, BOB, settle } from './helpers';
import { loadWasmForTests } from './support';

const ME_NUMBER = '+15550009999';
const CAROL = '33333333-3333-4333-8333-333333333333';

const kv = new Map<string, any>();
const keys = new Map<string, any>();
const identities = new Map<string, any>();
const gets: string[] = [];
let directoryChanges = 0;
let profiles: Record<string, string> = {};

const fakeHost = {
  http: {
    async request(method: string, path: string) {
      if (method !== 'GET' || !path.startsWith('/v1/profile/')) throw Object.assign(new Error('HTTP 404'), { status: 404 });
      gets.push(path);
      const aci = decodeURIComponent(path.split('/')[3]);
      return profiles[aci] ? { name: profiles[aci] } : {};
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
  ingest: () => {},
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
});
