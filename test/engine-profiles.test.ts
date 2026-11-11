import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as official from '@signalapp/libsignal-client';

import { concatBytes, fromBase64, randomBytes, uuidToBytes } from '../src/engine/bytes';
import { libsignal } from '../src/engine/protocol/libsignal';
import { avatarUploadBody, decryptProfile, decryptProfileName, encryptProfileName, uploadOwnProfile } from '../src/engine/services/profiles';
import { MemorySignalStore } from '../src/engine/protocol/store';
import { deleteUsername, setUsername, usernameCandidates, usernameLinkUrl } from '../src/engine/services/usernames';
import { ALICE } from './helpers';
import { loadWasmForTests } from './support';

before(() => {
  loadWasmForTests();
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
