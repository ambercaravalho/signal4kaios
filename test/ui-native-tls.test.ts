import './ui-env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as nativeTls from '../src/ui/data/nativeTls';

type Outcome = 'status' | 'zero' | 'error' | 'timeout';

class FakeXhr {
  static outcome: Outcome = 'status';
  static made: FakeXhr[] = [];
  opts: any;
  method = '';
  url = '';
  status = 0;
  timeout = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  constructor(opts?: any) {
    this.opts = opts;
    FakeXhr.made.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send() {
    setTimeout(() => {
      if (FakeXhr.outcome === 'status') {
        this.status = 404;
        this.onload?.();
      } else if (FakeXhr.outcome === 'zero') this.onload?.();
      else if (FakeXhr.outcome === 'error') this.onerror?.();
      else this.ontimeout?.();
    }, 1);
  }
}
(globalThis as any).XMLHttpRequest = FakeXhr;

function probeWith(outcome: Outcome): Promise<boolean> {
  FakeXhr.outcome = outcome;
  return nativeTls.probe();
}

function networkError(): Error {
  return Object.assign(new Error('network'), { kind: 'network' });
}

describe('native TLS', () => {
  it('stays on pinned TLS until a probe succeeds', () => {
    assert.equal(nativeTls.nativeTlsState(), 'unknown');
    assert.equal(nativeTls.useBuiltIn('https://cdn.signal.org/attachments/x'), false);
  });

  it('probes Signal’s CDN once with a system XHR, and treats any HTTP status as trusted', async () => {
    FakeXhr.made = [];
    const seen: string[] = [];
    const off = nativeTls.onNativeTlsChange((s) => seen.push(s));
    FakeXhr.outcome = 'status';
    const [a, b] = await Promise.all([nativeTls.probe(), nativeTls.probe()]);
    off();
    assert.equal(a, true);
    assert.equal(b, true);
    assert.equal(FakeXhr.made.length, 1);
    assert.deepEqual(FakeXhr.made[0].opts, { mozSystem: true });
    assert.equal(FakeXhr.made[0].method, 'HEAD');
    assert.equal(FakeXhr.made[0].url, 'https://cdn.signal.org/');
    assert.deepEqual(seen, ['trusted']);
  });

  it('uses the platform only for Signal’s attachment CDNs', async () => {
    await probeWith('status');
    for (const url of ['https://cdn.signal.org/attachments/a', 'https://cdn2.signal.org/attachments/b', 'https://cdn3.signal.org/tus/c']) assert.equal(nativeTls.useBuiltIn(url), true, url);
    for (const url of [
      'https://chat.signal.org/v1/messages',
      'wss://chat.signal.org/v1/websocket/',
      'https://storage.signal.org/v1/storage',
      'https://updates.signal.org/',
      'http://cdn.signal.org/attachments/a',
      'https://cdn.signal.org:8443/attachments/a',
      'https://cdn.signal.org.example.com/attachments/a',
      'not a url',
    ])
      assert.equal(nativeTls.useBuiltIn(url), false, url);
  });

  it('reports untrusted when the connection fails, returns no status, or times out', async () => {
    for (const outcome of ['error', 'zero', 'timeout'] as const) {
      await probeWith('status');
      assert.equal(await probeWith(outcome), false, outcome);
      assert.equal(nativeTls.nativeTlsState(), 'untrusted', outcome);
      assert.equal(nativeTls.useBuiltIn('https://cdn.signal.org/attachments/a'), false, outcome);
    }
  });

  it('falls back to pinned TLS and stops using the platform after a network error', async () => {
    await probeWith('status');
    let pinnedCalls = 0;
    const out = await nativeTls.withFallback(
      () => Promise.reject(networkError()),
      () => (pinnedCalls++, Promise.resolve('pinned'))
    );
    assert.equal(out, 'pinned');
    assert.equal(pinnedCalls, 1);
    assert.equal(nativeTls.nativeTlsState(), 'untrusted');
  });

  it('passes other failures through without retrying', async () => {
    await probeWith('status');
    const httpErr = Object.assign(new Error('HTTP 404'), { kind: 'http', status: 404 });
    let pinnedCalls = 0;
    await assert.rejects(
      nativeTls.withFallback(
        () => Promise.reject(httpErr),
        () => (pinnedCalls++, Promise.resolve('pinned'))
      ),
      httpErr
    );
    assert.equal(pinnedCalls, 0);
    assert.equal(nativeTls.nativeTlsState(), 'trusted');
    assert.equal(await nativeTls.withFallback(() => Promise.resolve('built-in'), () => Promise.resolve('pinned')), 'built-in');
  });
});
