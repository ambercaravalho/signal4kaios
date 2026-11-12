import './ui-env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { concatBytes } from '../src/engine/bytes';
import { createNet, net } from '../src/engine/net/transport';
import { ByteStream, Connector } from '../src/engine/net/transport/stream';
import { TlsSession } from '../src/engine/net/transport/tls-stream';
import { config } from '../src/ui/data/config';
import { activeProxy, isProxyLink, parseProxyLink, saveProxy, validProxyHost } from '../src/ui/data/proxy';
import { text, utf8 } from './helpers';

describe('proxy links', () => {
  it('reads the host from signal.tube links and typed addresses', () => {
    assert.equal(parseProxyLink('https://signal.tube/#proxy.example.com'), 'proxy.example.com');
    assert.equal(parseProxyLink('  https://signal.tube/#Proxy.Example.COM  '), 'proxy.example.com');
    assert.equal(parseProxyLink('sgnl://signal.tube/?host=proxy.example.com'), 'proxy.example.com');
    assert.equal(parseProxyLink('sgnl://signal.tube?foo=1&host=proxy.example.com&bar=2'), 'proxy.example.com');
    assert.equal(parseProxyLink('proxy.example.com'), 'proxy.example.com');
    assert.equal(parseProxyLink('https://proxy.example.com/'), 'proxy.example.com');
    assert.equal(parseProxyLink('proxy.example.com:443'), 'proxy.example.com');
    assert.equal(isProxyLink('https://signal.tube/#proxy.example.com'), true);
    assert.equal(isProxyLink('https://signal.group/#abc'), false);
    assert.equal(isProxyLink('proxy.example.com'), false);
  });

  it('rejects anything that is not a plain hostname on port 443', () => {
    for (const bad of [
      '',
      'https://signal.tube/#',
      'https://signal.tube/#proxy.example.com:8443',
      'proxy.example.com:8443',
      'http://proxy.example.com',
      'https://proxy.example.com/path',
      'user@proxy.example.com',
      'localhost',
      '192.168.1.1',
      '-bad.example.com',
      'bad-.example.com',
      'a..example.com',
      'proxy.example.com.',
      'pr oxy.example.com',
      'proxy_1.example.com',
      'https://signal.tube/#%E2%80%AEevil.com',
      'https://signal.tube/#%ZZ',
      'chat.signal.org',
      'signal.org',
      'signal.tube',
      'x'.repeat(64) + '.example.com',
    ])
      assert.equal(parseProxyLink(bad), null, bad);
    assert.equal(validProxyHost('a.' + 'b'.repeat(63) + '.com'), true);
  });

  it('keeps the address while the proxy is off', () => {
    saveProxy('proxy.example.com', true);
    assert.equal(activeProxy(), 'proxy.example.com');
    assert.equal(net.proxy(), 'proxy.example.com');
    saveProxy('proxy.example.com', false);
    assert.equal(config.proxyAddress(), 'proxy.example.com');
    assert.equal(activeProxy(), null);
    assert.equal(net.proxy(), null);
  });
});

/** A TLS session that passes bytes straight through once the server's first flight arrives, recording the host it was opened for. */
function passthroughSession(hosts: string[]) {
  return (host: string): TlsSession => {
    hosts.push(host);
    let handshaking = true;
    let out: Uint8Array = text('client hello');
    let unread: Uint8Array = new Uint8Array(0);
    return {
      feed(data) {
        if (handshaking) handshaking = false;
        else unread = concatBytes(unread, data);
      },
      takeOutgoing() {
        const o = out;
        out = new Uint8Array(0);
        return o;
      },
      write(data) {
        out = concatBytes(out, data);
      },
      read() {
        const r = unread;
        unread = new Uint8Array(0);
        return r;
      },
      isHandshaking: () => handshaking,
      peerClosed: () => false,
      closeNotify() {},
      free() {},
    };
  };
}

/** A server that finishes the handshake and answers every request with 204. */
function server(dials: string[], label: string): Connector {
  return async (host, port) => {
    dials.push(`${label} ${host}:${port}`);
    let seen = '';
    const stream: ByteStream = {
      write(data) {
        const chunk = utf8(data);
        if (chunk === 'client hello') setImmediate(() => stream.onData && stream.onData(text('server hello')));
        else {
          seen += chunk;
          if (seen.includes('\r\n\r\n')) {
            seen = '';
            setImmediate(() => stream.onData && stream.onData(text('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n')));
          }
        }
        return true;
      },
      close() {},
      onData: null,
      onClose: null,
      onDrain: null,
    };
    return stream;
  };
}

describe('connections through a proxy', () => {
  function setup(withSecure = true) {
    const dials: string[] = [];
    const sni: string[] = [];
    const n = createNet({
      connectRaw: server(dials, 'tcp'),
      connectSecure: withSecure ? server(dials, 'tls') : undefined,
      newSession: passthroughSession(sni),
      isPinnedHost: (h) => h.endsWith('.signal.org'),
      available: () => true,
    });
    return { n, dials, sni };
  }

  it('connects directly without a proxy', async () => {
    const { n, dials, sni } = setup();
    const res = await n.request({ method: 'GET', url: 'https://chat.signal.org/v1/config' });
    assert.equal(res.status, 204);
    assert.deepEqual(dials, ['tcp chat.signal.org:443']);
    assert.deepEqual(sni, ['chat.signal.org']);
  });

  it('opens platform TLS to the proxy on port 443 and keeps the Signal host as the inner name', async () => {
    const { n, dials, sni } = setup();
    n.setProxy('proxy.example.com');
    assert.equal(n.proxy(), 'proxy.example.com');
    const res = await n.request({ method: 'GET', url: 'https://storage.signal.org/v1/storage' });
    assert.equal(res.status, 204);
    assert.deepEqual(dials, ['tls proxy.example.com:443']);
    assert.deepEqual(sni, ['storage.signal.org']);
  });

  it('drops kept-alive connections when the proxy changes', async () => {
    const { n, dials } = setup();
    await n.request({ method: 'GET', url: 'https://chat.signal.org/a' });
    n.setProxy('proxy.example.com');
    await n.request({ method: 'GET', url: 'https://chat.signal.org/b' });
    n.setProxy(null);
    await n.request({ method: 'GET', url: 'https://chat.signal.org/c' });
    assert.deepEqual(dials, ['tcp chat.signal.org:443', 'tls proxy.example.com:443', 'tcp chat.signal.org:443']);
  });

  it('says the proxy did not answer when it can’t be reached', async () => {
    const n = createNet({
      connectRaw: server([], 'tcp'),
      connectSecure: () => Promise.reject(Object.assign(new Error('refused'), { kind: 'network' })),
      newSession: passthroughSession([]),
      isPinnedHost: () => true,
      available: () => true,
    });
    n.setProxy('proxy.example.com');
    await assert.rejects(n.request({ method: 'GET', url: 'https://chat.signal.org/x' }), (e: any) => e.kind === 'network' && /proxy proxy\.example\.com did not answer/.test(e.message));
  });

  it('refuses a platform WebSocket while a proxy is set', () => {
    const n = createNet({ connectRaw: server([], 'tcp'), newSession: passthroughSession([]), isPinnedHost: () => true, available: () => false });
    n.setProxy('proxy.example.com');
    assert.throws(() => n.openWebSocket('wss://chat.signal.org/v1/websocket/'), /proxy is set/);
  });
});
