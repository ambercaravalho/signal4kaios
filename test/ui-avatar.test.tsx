import './ui-env';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'preact-render-to-string';

import { Avatar, loadPhoto } from '../src/ui/components/Avatar';
import { signal } from '../src/ui/data/api';
import { config } from '../src/ui/data/config';
import { db } from '../src/ui/data/db';
import * as store from '../src/ui/data/store';

const group = (internal_id: string, name: string, avatar?: string) => ({ id: 'group.' + internal_id, internal_id, name, members: [], admins: [], pending: [], ...(avatar === undefined ? {} : { avatar }) });
const subject = (internalId: string, name: string) => ({ id: 'g:' + internalId, type: 'group' as const, name, groupInternalId: internalId });

describe('group avatars in the app', () => {
  const asked: string[] = [];

  before(async () => {
    config.set({ number: '+15550000', aci: '00000000-0000-4000-8000-000000000000', deviceId: 2, deviceToken: 'test-only' });
    await db.ready();
    (signal as any).groupAvatarBlob = async (internalId: string) => {
      asked.push(internalId);
      return new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    };
    await db.kvSet('syncedGroups', [group('RkFN', 'Family', 'groups/one'), group('Q0hT', 'Chess', ''), group('T0xE', 'Old')]);
    await store.refreshDirectory();
  });

  it('shows the group photo from the engine', async () => {
    assert.match((await loadPhoto(subject('RkFN', 'Family'))) || '', /^blob:/);
    assert.match(renderToString(<Avatar conv={subject('RkFN', 'Family')} />), /class="avatar-img" src="blob:/);
    assert.deepEqual(asked, ['RkFN']);
  });

  it('shows initials without asking the engine when the group has no photo', async () => {
    assert.equal(await loadPhoto(subject('Q0hT', 'Chess')), null);
    assert.doesNotMatch(renderToString(<Avatar conv={subject('Q0hT', 'Chess')} />), /avatar-img/);
    assert.ok(!asked.includes('Q0hT'));
  });

  it('asks the engine for groups saved before the avatar key was recorded', async () => {
    assert.match((await loadPhoto(subject('T0xE', 'Old'))) || '', /^blob:/);
    assert.ok(asked.includes('T0xE'));
  });

  it('loads the new photo when the group photo changes', async () => {
    await loadPhoto(subject('RkFN', 'Family'));
    assert.equal(asked.filter((id) => id === 'RkFN').length, 1);
    await db.kvSet('syncedGroups', [group('RkFN', 'Family', 'groups/two'), group('Q0hT', 'Chess', ''), group('T0xE', 'Old')]);
    await store.refreshDirectory();
    await loadPhoto(subject('RkFN', 'Family'));
    assert.equal(asked.filter((id) => id === 'RkFN').length, 2);
  });
});
