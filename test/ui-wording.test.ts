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

  it('keeps hints to a line or two and dialog bodies to a few', () => {
    for (const [key, value] of Object.entries(S)) {
      const limit = /Hint$/.test(key) ? 60 : /Body$|^cantStart/.test(key) ? 120 : key === 'linkSteps' ? 80 : 0;
      if (limit) assert.ok(value.length <= limit, `S.${key} is ${value.length} characters, over ${limit}: "${value}"`);
    }
  });
});

describe('softkey labels', () => {
  it('fit under the screen: at most 10 characters', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : /\.tsx?$/.test(name) ? [join(dir, name)] : []));
    const long: string[] = [];
    for (const f of files('src/ui')) {
      const src = readFileSync(f, 'utf8');
      const softkeyLines = src.split('\n').filter((l) => /useSoftkeys\(|\b(left|center|right|ok):|const label = |class="sk sk-/.test(l) && !/^\s*(\/\/|\*|\/\*\*)/.test(l));
      for (const l of softkeyLines) {
        const values = /class="sk sk-/.test(l) ? [l] : Array.from(l.matchAll(/\b(?:left|center|right|ok|label)\s*[:=]\s*([^,;}]*)/g), (m) => m[1]);
        for (const value of values) {
          for (const k of value.matchAll(/\bS\.(\w+)/g)) {
            const v = (S as Record<string, string>)[k[1]];
            if (typeof v === 'string' && v.length > 10) long.push(f + ': S.' + k[1] + ' "' + v + '"');
          }
        }
      }
    }
    assert.deepEqual(long, []);
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

  it('blames the phone’s clock when Signal’s certificate looks expired or not yet valid', () => {
    const tls = (detail: string) => ({ kind: 'tls', message: 'secure connection failed: invalid peer certificate: ' + detail });
    assert.equal(friendlyError(tls('certificate expired: verification time 1 (UNIX), but certificate is not valid after 0 (1 seconds ago)')), S.errClock);
    assert.equal(friendlyError(tls('certificate not valid yet: verification time 0 (UNIX), but certificate is not valid before 1 (1 seconds in future)')), S.errClock);
    assert.equal(friendlyError(tls('NotValidYet')), S.errClock);
    assert.equal(friendlyError({ kind: 'clock', message: 'clock' }), S.errClock);
    assert.equal(friendlyError(tls('UnknownIssuer')), S.errOffline);
    assert.equal(friendlyError(tls('certificate revocation list expired: verification time 1')), S.errOffline);
  });

  it('tells a taken username from an invalid one and from too many tries', () => {
    const err = (name: string) => Object.assign(new Error('x'), { name, code: name });
    assert.equal(friendlyError(err('UsernameUnavailable')), S.usernameTaken);
    assert.equal(friendlyError(err('UsernameReservationLost')), S.usernameTaken);
    assert.equal(friendlyError(err('UsernameInvalid')), S.usernameInvalid);
    assert.equal(friendlyError(err('UsernameRateLimited')), S.errRateLimited);
  });

  it('says what went wrong with a group change, a changed safety number, or Signal’s challenge', () => {
    const err = (name: string, status?: number) => Object.assign(new Error('x'), { name, status });
    assert.equal(friendlyError(err('LastAdmin')), S.errLastAdmin);
    assert.equal(friendlyError(err('GroupChangeForbidden', 403)), S.errGroupAdminsOnly);
    assert.equal(friendlyError(err('GroupChangeConflict', 409)), S.errGroupConflict);
    assert.equal(friendlyError(err('NotAMember')), S.errNotAMember);
    assert.equal(friendlyError(err('UntrustedIdentity')), S.errSafetyNumber);
    assert.equal(friendlyError({ kind: 'http', status: 428 }), S.errChallenge);
  });

  it('never echoes the raw message', () => {
    const raw = 'libsignal: invalid PreKey bundle for ACI abc';
    assert.equal(friendlyError(new Error(raw)), S.errGeneric);
    assert.equal(friendlyError(new Error(raw), S.errSend), S.errSend);
    assert.equal(friendlyError(new Error('group not ready')), S.groupNotReady);
  });
});
