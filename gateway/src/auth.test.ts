import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Point the shared DB at a throwaway file before any module opens it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's4k-auth-'));
process.env.DB_PATH = path.join(dir, 'test.db');

const auth: typeof import('./auth') = require('./auth');
const { db }: typeof import('./db') = require('./db');
const buffer: typeof import('./buffer') = require('./buffer');

test('a code pairs exactly once and yields a working token', function () {
  const c = auth.issueCode();
  assert.match(c.code, /^\d{8}$/);
  const paired = auth.redeem(auth.formatCode(c.code), 'Test phone');
  assert.ok(paired);
  assert.match(paired.token, /^[0-9a-f]{64}$/);
  assert.equal(auth.verify(paired.token), paired.id);
  assert.equal(auth.redeem(c.code, 'Again'), null);
});

test('codes and tokens are stored only as hashes', function () {
  const c = auth.issueCode();
  const paired = auth.redeem(c.code, 'Hash check');
  assert.ok(paired);
  const dump = JSON.stringify(db.prepare('SELECT * FROM devices').all()) +
    JSON.stringify(db.prepare('SELECT * FROM pairing_codes').all());
  assert.ok(dump.indexOf(paired.token) === -1);
  assert.ok(dump.indexOf(c.code) === -1);
});

test('an expired code is rejected', function () {
  const now = Date.now();
  const c = auth.issueCode(now);
  assert.equal(auth.redeem(c.code, 'Late', now + auth.CODE_TTL_MS + 1), null);
});

test('too many wrong attempts burn the code', function () {
  const c = auth.issueCode();
  const wrong = c.code === '00000000' ? '11111111' : '00000000';
  for (let i = 0; i < auth.MAX_CODE_ATTEMPTS; i++) {
    assert.equal(auth.redeem(wrong, 'Guess'), null);
  }
  assert.equal(auth.redeem(c.code, 'Real'), null);
});

test('issuing a new code invalidates the old one', function () {
  const first = auth.issueCode();
  const second = auth.issueCode();
  if (first.code !== second.code) assert.equal(auth.redeem(first.code, 'Old'), null);
  assert.ok(auth.redeem(second.code, 'New'));
});

test('revoke removes the device and its push subscriptions', function () {
  const paired = auth.redeem(auth.issueCode().code, 'Revoke me');
  assert.ok(paired);
  buffer.addSub('+15550001111', { endpoint: 'https://push.example/x' }, paired.id);
  assert.equal(buffer.subsFor('+15550001111').length, 1);
  assert.ok(auth.revoke(paired.id));
  assert.equal(auth.verify(paired.token), null);
  assert.equal(auth.exists(paired.id), false);
  assert.equal(buffer.subsFor('+15550001111').length, 0);
});

test('a new subscription replaces the device\'s older ones but not other devices\'', function () {
  const a = auth.redeem(auth.issueCode().code, 'Phone A');
  const b = auth.redeem(auth.issueCode().code, 'Phone B');
  assert.ok(a && b);
  const n = '+15550002222';
  buffer.addSub(n, { endpoint: 'https://push.example/a1' }, a.id);
  buffer.addSub(n, { endpoint: 'https://push.example/b1' }, b.id);
  buffer.addSub(n, { endpoint: 'https://push.example/a2' }, a.id);
  buffer.addSub(n, { endpoint: 'https://push.example/a2' }, a.id);
  const eps = buffer.subsFor(n).map(function (s) { return (s as { endpoint: string }).endpoint; }).sort();
  assert.deepEqual(eps, ['https://push.example/a2', 'https://push.example/b1']);
});

test('verify rejects malformed tokens', function () {
  assert.equal(auth.verify(''), null);
  assert.equal(auth.verify('not-a-token'), null);
  assert.equal(auth.verify('a'.repeat(64)), null);
});

test('bearer parses the Authorization header', function () {
  assert.equal(auth.bearer('Bearer abc'), 'abc');
  assert.equal(auth.bearer('Basic abc'), null);
  assert.equal(auth.bearer(undefined), null);
});

test('pair attempts are throttled per IP', function () {
  const now = Date.now();
  let allowed = 0;
  for (let i = 0; i < 20; i++) if (auth.allowPairAttempt('10.0.0.9', now)) allowed++;
  assert.equal(allowed, 10);
  assert.ok(auth.allowPairAttempt('10.0.0.10', now));
});
