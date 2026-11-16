import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const POLYFILL = readFileSync('scripts/gecko84-polyfill.js', 'utf8');

const LOAD_HASHES = `
const { sha256 } = await import('@noble/hashes/sha2.js');
await import('@noble/hashes/hmac.js');
await import('@noble/hashes/hkdf.js');
await import('@noble/hashes/legacy.js');
const hex = Array.from(sha256(new TextEncoder().encode('abc')), (b) => b.toString(16).padStart(2, '0')).join('');
console.log(hex);
`;

function runWithoutHasOwn(prelude: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', 'delete Object.hasOwn;\n' + prelude + '\n' + LOAD_HASHES], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

test('gecko84: @noble/hashes loads without Object.hasOwn once the bundle polyfill has run', () => {
  const r = runWithoutHasOwn(POLYFILL);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('gecko84: the polyfill starts with "use strict", so the bundles after it stay strict', () => {
  assert.match(POLYFILL.replace(/^\/\*[\s\S]*?\*\//, '').trimStart(), /^'use strict';/);
});

test('gecko84: without the polyfill @noble/hashes throws while loading, as on KaiOS 3.x', () => {
  const r = runWithoutHasOwn('');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Object\.hasOwn is not a function/);
});
