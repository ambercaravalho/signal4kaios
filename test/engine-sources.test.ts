import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const STORE_IDENTITY_CALL = /\.(saveIdentity|getIdentity|setIdentityTrust|removeIdentity|getAllIdentities)\(/;
const OWNERS = [join('src', 'engine', 'protocol', 'protocol.ts'), join('src', 'engine', 'protocol', 'store.ts')];

describe('engine source rules', () => {
  it('reads and writes identity records only through protocol.ts', () => {
    const offenders = filesUnder('src/engine')
      .filter((f) => OWNERS.indexOf(f) < 0)
      .filter((f) => STORE_IDENTITY_CALL.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, []);
  });

  it('keeps identity record calls out of the app', () => {
    const offenders = filesUnder('src/ui').filter((f) => STORE_IDENTITY_CALL.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, []);
  });
});
