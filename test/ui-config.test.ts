import './ui-env';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { leaveUnlinkedAccount, openLinkDatabase, wipeAllData } from '../src/ui/data/api';
import { config } from '../src/ui/data/config';
import { db } from '../src/ui/data/db';

const ANN = { number: '+15550101', aci: 'aci-ann', deviceId: 2, deviceToken: 'test-only-ann' };
const BEN = { number: '+15550202', aci: 'aci-ben', deviceId: 3, deviceToken: 'test-only-ben' };

function link(acc: typeof ANN): void {
  config.prepareAccount(acc.aci);
  config.set({ ...acc, dbNumber: acc.number });
  config.saveActiveAccount();
}

describe('settings per account', () => {
  beforeEach(() => config.clear());

  it('starts a newly linked account with its own defaults, not the previous account’s', () => {
    link(ANN);
    config.set({ profileName: 'Ann', sendReadReceipts: false, theme: 'dark', chatFolders: [{ id: 'f1', name: 'Work', included: [], excluded: [] } as any] });
    link(BEN);
    assert.equal(config.profileName(), '');
    assert.equal(config.sendReadReceipts(), true);
    assert.deepEqual(config.chatFolders(), []);
    assert.equal(config.theme(), 'dark', 'the phone’s own settings stay');
  });

  it('brings each account’s settings back when switching, without waiting for a sync', () => {
    link(ANN);
    config.set({ profileName: 'Ann', sendReadReceipts: false, username: 'ann.01' });
    link(BEN);
    config.set({ profileName: 'Ben', notifyCallsIfMuted: true });

    assert.ok(config.switchAccount(ANN.number));
    assert.equal(config.aci(), ANN.aci);
    assert.equal(config.profileName(), 'Ann');
    assert.equal(config.sendReadReceipts(), false);
    assert.equal(config.username(), 'ann.01');
    assert.equal(config.notifyCallsIfMuted(), false);

    assert.ok(config.switchAccount(BEN.number));
    assert.equal(config.profileName(), 'Ben');
    assert.equal(config.sendReadReceipts(), true);
    assert.equal(config.username(), '');
    assert.equal(config.notifyCallsIfMuted(), true);
  });

  it('keeps the active account’s settings when it is linked again', () => {
    link(ANN);
    config.set({ profileName: 'Ann' });
    link(ANN);
    assert.equal(config.profileName(), 'Ann');
  });
});

describe('relinking, unlinking, and deleting everything', () => {
  beforeEach(() => config.clear());

  it('starts a relink with no keys or sessions from before, and keeps the messages', async () => {
    await db.useAccount(ANN.number);
    await db.putSession(BEN.aci + '.1', new Uint8Array([1, 2, 3]));
    await db.signalKeySet('account', { aci: ANN.aci, password: 'test-only-old' });
    await db.kvSet('history', 'kept');
    await openLinkDatabase({ aci: ANN.aci, number: ANN.number });
    assert.equal(await db.getSession(BEN.aci + '.1'), undefined);
    assert.equal(await db.signalKeyGet('account'), undefined);
    assert.equal(await db.kvGet('history'), 'kept');
    await db.useAccount(null);
  });

  it('relinks into the old database after a number change, even once another account is active', async () => {
    link(ANN);
    config.changeNumber('+15550909');
    link(BEN);
    assert.ok(config.switchAccount('+15550909'));
    leaveUnlinkedAccount();
    assert.equal(config.aci(), BEN.aci);

    await db.useAccount(ANN.number);
    await db.kvSet('history', 'ann');
    await openLinkDatabase({ aci: ANN.aci, number: '+15550909' });
    assert.equal(db.name(), db.nameFor(ANN.number));
    assert.equal(await db.kvGet('history'), 'ann');
    await db.useAccount(null);
    assert.equal(config.dbKeyFor(ANN.aci, '+15550909'), ANN.number);
    assert.equal(config.dbKeyFor('aci-new', '+15550303'), '+15550303');
  });

  it('switches to the next saved account after unlinking this one', () => {
    link(ANN);
    config.set({ profileName: 'Ann' });
    link(BEN);
    config.set({ profileName: 'Ben' });
    leaveUnlinkedAccount();
    assert.equal(config.number(), ANN.number);
    assert.equal(config.deviceToken(), ANN.deviceToken);
    assert.equal(config.profileName(), 'Ann');
    assert.deepEqual(config.accounts().map((a) => a.number), [ANN.number]);
  });

  it('deletes every database it has opened, and keeps settings when one can’t be deleted', async () => {
    link(ANN);
    link(BEN);
    for (const acc of [ANN, BEN]) {
      await db.useAccount(acc.number);
      await db.kvSet('marker', acc.number);
    }
    await db.useAccount(null);
    const before = await db.listDatabases();
    for (const acc of [ANN, BEN]) assert.ok(before.includes(db.nameFor(acc.number)), acc.number);

    const real = indexedDB.deleteDatabase.bind(indexedDB);
    (indexedDB as any).deleteDatabase = (name: string) => {
      if (name !== db.nameFor(BEN.number)) return real(name);
      const req: any = { error: new Error('blocked') };
      setTimeout(() => req.onerror && req.onerror());
      return req;
    };
    try {
      assert.equal(await wipeAllData(), false);
    } finally {
      (indexedDB as any).deleteDatabase = real;
    }
    assert.equal(config.accounts().length, 2, 'settings stay for another try');

    assert.equal(await wipeAllData(), true);
    const after = await db.listDatabases();
    for (const acc of [ANN, BEN]) assert.ok(!after.includes(db.nameFor(acc.number)), acc.number);
    assert.deepEqual(config.accounts(), []);
  });
});
