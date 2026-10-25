import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseAccounts } from './signal';

test('parseAccounts reads the plain string shape (signal-cli-rest-api <= 0.101)', function () {
  assert.deepEqual(parseAccounts(['+15550001111', '+15550002222']), ['+15550001111', '+15550002222']);
});

test('parseAccounts reads the object shape and skips numberless accounts', function () {
  assert.deepEqual(parseAccounts([
    { number: '+15550001111', aci: '11111111-1111-4111-8111-111111111111' },
    { number: '', aci: '22222222-2222-4222-8222-222222222222' },
    { number: null, aci: '33333333-3333-4333-8333-333333333333' }
  ]), ['+15550001111']);
});

test('parseAccounts drops garbage and duplicates', function () {
  assert.deepEqual(parseAccounts(null), []);
  assert.deepEqual(parseAccounts({ number: '+15550001111' }), []);
  assert.deepEqual(parseAccounts([42, 'not-a-number', {}, '+15550001111', '+15550001111']), ['+15550001111']);
});
