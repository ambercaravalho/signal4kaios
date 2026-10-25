import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Point the shared DB at a throwaway file before any module opens it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's4k-push-'));
process.env.DB_PATH = path.join(dir, 'test.db');

const push: typeof import('./push') = require('./push');
const { getSetting, setSetting }: typeof import('./db') = require('./db');

test('VAPID keys are generated once, stored, then reused', function () {
  const first = push.resolveVapidKeys('', '');
  assert.equal(first.source, 'generated');
  assert.match(first.publicKey, /^[A-Za-z0-9_-]{80,}$/);
  const second = push.resolveVapidKeys('', '');
  assert.equal(second.source, 'stored');
  assert.equal(second.publicKey, first.publicKey);
  assert.equal(second.privateKey, first.privateKey);
});

test('VAPID keys from the environment win over stored keys', function () {
  const stored = getSetting('vapid_keys');
  const env = push.resolveVapidKeys('envPublic', 'envPrivate');
  assert.deepEqual(env, { publicKey: 'envPublic', privateKey: 'envPrivate', source: 'env' });
  assert.equal(getSetting('vapid_keys'), stored);
});

test('only one env key set falls back to the stored pair', function () {
  assert.equal(push.resolveVapidKeys('envPublic', '').source, 'stored');
});

test('an unreadable stored value is replaced with a fresh pair', function () {
  setSetting('vapid_keys', 'not json');
  const keys = push.resolveVapidKeys('', '');
  assert.equal(keys.source, 'generated');
  assert.equal(push.resolveVapidKeys('', '').publicKey, keys.publicKey);
});
