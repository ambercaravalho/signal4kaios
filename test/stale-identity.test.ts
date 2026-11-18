/* A contact's identity key changes while we hold sessions with several of their devices: the session that brought the new key uses it, and the others still hold the old one. */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SignalClient } from '../src/engine/net/client';
import { ContentSchema } from '../src/engine/gen/SignalService_pb';
import { create } from '../src/engine/net/proto';
import { hasUsableSession } from '../src/engine/protocol/protocol';
import { ALICE, BOB } from './helpers';
import { connect, loadWasmForTests, newAccount, serverKeysFor, type TestAccount } from './support';

before(() => {
  loadWasmForTests();
});

/** Another device of `account`'s owner, with the same identity key. */
async function sibling(account: TestAccount, deviceId: number): Promise<TestAccount> {
  const dev = newAccount(account.aci, deviceId);
  const base = (await account.store.getAccount())!;
  await dev.store.saveAccount({ ...(await dev.store.getAccount())!, aciIdentityKeyPair: base.aciIdentityKeyPair });
  return { ...dev, identityPublic: base.aciIdentityKeyPair.pubKey };
}

/** Alice holds sessions with Bob's devices 1 and 2; then Bob's key changes and only device 1's session learns it. */
async function changedKey() {
  const alice = newAccount(ALICE, 2);
  await connect(alice, newAccount(BOB, 2));
  const bob1 = newAccount(BOB, 1);
  await connect(alice, bob1);
  return { alice, bob1, bob2: await sibling(bob1, 2) };
}

function fakeServer(keysFor: Record<number, () => Promise<any>>) {
  const puts: any[] = [];
  const gets: string[] = [];
  const httpJson = async (method: string, path: string, body?: any): Promise<any> => {
    if (method === 'GET' && path.startsWith(`/v2/keys/${BOB}/`)) {
      gets.push(path);
      const keys = keysFor[Number(path.split('/').pop())];
      if (!keys) throw Object.assign(new Error('HTTP 404'), { status: 404 });
      return keys();
    }
    if (method === 'PUT' && path === `/v1/messages/${BOB}`) {
      puts.push(body);
      return {};
    }
    throw Object.assign(new Error('unexpected ' + method + ' ' + path), { status: 500 });
  };
  return { httpJson, puts, gets };
}

const content = () => create(ContentSchema, { content: { case: 'dataMessage', value: { body: 'answer', timestamp: 1n } } });

describe('sessions left on an old identity key', () => {
  it('count as unusable, so a send fetches new PreKeys for that device instead of failing', async () => {
    const { alice, bob2 } = await changedKey();
    assert.equal(await hasUsableSession(alice.store, BOB, 1), true);
    assert.equal(await hasUsableSession(alice.store, BOB, 2), false, 'device 2 still has the old key');
    const server = fakeServer({ 2: () => serverKeysFor(bob2) });
    const client = new SignalClient(alice.store, server.httpJson as any, async () => new Uint8Array(0));
    await client.sendContentToRecipient(BOB, content(), 1);
    assert.deepEqual(server.gets, [`/v2/keys/${BOB}/2`]);
    assert.equal(server.puts.length, 1);
    assert.deepEqual(server.puts[0].messages.map((m: any) => m.destinationDeviceId).sort(), [1, 2]);
    assert.equal(server.puts[0].messages.find((m: any) => m.destinationDeviceId === 2).type, 3, 'a new session, so a PreKey message');
    assert.equal(await hasUsableSession(alice.store, BOB, 2), true);
  });

  it('is dropped when the server no longer has the device', async () => {
    const { alice } = await changedKey();
    const server = fakeServer({});
    const client = new SignalClient(alice.store, server.httpJson as any, async () => new Uint8Array(0));
    await client.sendContentToRecipient(BOB, content(), 1);
    assert.deepEqual(server.puts[0].messages.map((m: any) => m.destinationDeviceId), [1]);
    assert.equal(await alice.store.loadSession(BOB, 2), null);
  });
});
