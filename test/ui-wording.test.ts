import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { friendlyError } from '../src/ui/errors';
import { DEBUG, S } from '../src/ui/strings';

/** Terms that belong only on Settings > Debug. */
const JARGON = /\b(pre-?keys?|kyber|aci|pni|uuid|e164|websocket|libsignal|wasm|provisioning|e2ee|protobuf|envelope|zkgroup|sealed sender|sender key|tls|ciphertext|identity key)\b/i;

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** String literals and JSX text, with comments removed. */
function visibleText(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const literals: string[] = code.match(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) || [];
  const jsxText: string[] = code.match(/>[^<>{}\n]*[A-Za-z][^<>{}\n]*</g) || [];
  return literals.concat(jsxText);
}

describe('user-facing wording', () => {
  it('keeps technical terms out of every string outside DEBUG', () => {
    for (const [key, value] of Object.entries(S)) assert.ok(!JARGON.test(value), `S.${key} says "${value}"`);
  });

  it('keeps DEBUG labels distinct from the everyday strings', () => {
    assert.ok(Object.values(DEBUG).some((v) => JARGON.test(v)));
  });

  it('puts no raw jargon in screens or components', () => {
    const files = filesUnder('src/ui/screens').concat(filesUnder('src/ui/components'));
    assert.ok(files.length > 10);
    for (const f of files) {
      if (/Debug\.tsx$/.test(f)) continue;
      for (const text of visibleText(readFileSync(f, 'utf8'))) {
        if (/^['`][a-z0-9:./_-]*['`]$/i.test(text)) continue;
        assert.ok(!JARGON.test(text), `${f}: ${text}`);
      }
    }
  });
});

describe('friendlyError', () => {
  it('turns network failures into plain sentences', () => {
    assert.equal(friendlyError({ kind: 'network', message: 'TCPSocket error' }), S.errOffline);
    assert.equal(friendlyError({ kind: 'timeout', message: 'timed out' }), S.errTimeout);
    assert.equal(friendlyError(new Error('WebSocket closed')), S.errOffline);
  });

  it('maps HTTP statuses', () => {
    assert.equal(friendlyError({ kind: 'http', status: 401 }), S.errUnlinked);
    assert.equal(friendlyError({ kind: 'http', status: 403 }), S.errNotAllowed);
    assert.equal(friendlyError({ kind: 'http', status: 429 }), S.errRateLimited);
    assert.equal(friendlyError({ kind: 'http', status: 404 }), S.errNotFound);
  });

  it('never echoes the raw message', () => {
    const raw = 'libsignal: invalid PreKey bundle for ACI abc';
    assert.equal(friendlyError(new Error(raw)), S.errGeneric);
    assert.equal(friendlyError(new Error(raw), S.errSend), S.errSend);
    assert.equal(friendlyError(new Error('group not ready')), S.groupNotReady);
  });
});
