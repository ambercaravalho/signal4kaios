import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from '../src/engine/bytes';
import { GroupAttributeBlobSchema, GroupSchema } from '../src/engine/gen/Groups_pb';
import { create, toBinary } from '../src/engine/net/proto';
import { libsignal } from '../src/engine/protocol/libsignal';
import { downloadAndDecryptGroupAvatar, isGroupAvatarKey } from '../src/engine/services/group-avatar';
import { decodeGroupState, deriveGroupV2Keys } from '../src/engine/services/groups-v2';
import { loadWasmForTests } from './support';

before(() => {
  loadWasmForTests();
});

const KEY = 'groups/AbCdEfGhIjKlMnOpQrStUv';

describe('group avatars', () => {
  const keys = () => deriveGroupV2Keys(randomBytes(32));
  const blob = (secretParams: Uint8Array, content: any) => libsignal.groupEncryptBlob(secretParams, toBinary(GroupAttributeBlobSchema, create(GroupAttributeBlobSchema, { content })), 0);

  it('records the avatar key from the group state, empty when there is none', () => {
    const k = keys();
    assert.equal(decodeGroupState(k, create(GroupSchema, { version: 1, avatarUrl: KEY })).avatar, KEY);
    assert.equal(decodeGroupState(k, create(GroupSchema, { version: 1 })).avatar, '');
  });

  it('downloads the photo from CDN 0 and decrypts it with the group secret params', async () => {
    const k = keys();
    const photo = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    const urls: string[] = [];
    const httpBinary = async (method: string, url: string) => {
      urls.push(method + ' ' + url);
      return blob(k.secretParams, { case: 'avatar', value: photo });
    };
    assert.deepEqual(await downloadAndDecryptGroupAvatar(httpBinary, KEY, k.secretParams), photo);
    assert.deepEqual(urls, ['GET https://cdn.signal.org/' + KEY]);
  });

  it('refuses keys that could leave the groups folder, and blobs that are not an avatar', async () => {
    const k = keys();
    let calls = 0;
    const serve = (body: Uint8Array) => async () => {
      calls++;
      return body;
    };
    for (const bad of ['', 'groups/', '../profiles/x', 'groups/../x', 'https://evil.example/x', 'groups/a/b', 'profiles/abc']) {
      assert.equal(isGroupAvatarKey(bad), false, bad);
      await assert.rejects(downloadAndDecryptGroupAvatar(serve(new Uint8Array(0)), bad, k.secretParams), /Not a group avatar key/);
    }
    assert.equal(calls, 0);
    await assert.rejects(downloadAndDecryptGroupAvatar(serve(blob(k.secretParams, { case: 'title', value: 'Family' })), KEY, k.secretParams), /could not be decrypted/);
    await assert.rejects(downloadAndDecryptGroupAvatar(serve(blob(keys().secretParams, { case: 'avatar', value: new Uint8Array([1]) })), KEY, k.secretParams), /could not be decrypted/);
    await assert.rejects(downloadAndDecryptGroupAvatar(serve(randomBytes(40)), KEY, k.secretParams), /could not be decrypted/);
  });
});
