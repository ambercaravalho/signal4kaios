import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, Server } from 'node:tls';

import { libsignal } from '../src/engine/protocol/libsignal';
import { createNet } from '../src/engine/net/transport';
import { TransportError } from '../src/engine/net/transport/stream';
import { connectTls } from '../src/engine/net/transport/tls-stream';
import { loadWasmForTests, nodeConnector } from './support';

before(() => {
  loadWasmForTests();
});

describe('pinned TLS host gate', () => {
  it('accepts signal.org and its subdomains only', () => {
    for (const host of ['signal.org', 'chat.signal.org', 'CDN3.Signal.org', 'storage.signal.org']) assert.equal(libsignal.isPinnedTlsHost(host), true, host);
    for (const host of ['example.com', 'evilsignal.org', 'signal.org.example.com', '.signal.org', 'a..signal.org', 'signal.org.', '']) assert.equal(libsignal.isPinnedTlsHost(host), false, host);
  });

  it('refuses to start a session for another host', () => {
    assert.throws(() => new libsignal.TlsConn('example.com'), (e: Error) => e.name === 'TlsHostNotAllowed');
  });

  it('routes only Signal URLs through pinned TLS', () => {
    const net = createNet({ connectRaw: nodeConnector(), newSession: (h) => new libsignal.TlsConn(h), isPinnedHost: (h) => libsignal.isPinnedTlsHost(h), available: () => true });
    assert.equal(net.isPinnedUrl('https://chat.signal.org/v1/config'), true);
    assert.equal(net.isPinnedUrl('wss://chat.signal.org/v1/websocket/'), true);
    assert.equal(net.isPinnedUrl('https://storage.googleapis.com/upload'), false);
    assert.equal(net.isPinnedUrl('http://chat.signal.org/'), false);
    const off = createNet({ connectRaw: nodeConnector(), newSession: (h) => new libsignal.TlsConn(h), isPinnedHost: () => true, available: () => false });
    assert.equal(off.isPinnedUrl('https://chat.signal.org/'), false);
  });
});

describe('pinned TLS against an untrusted certificate', () => {
  let dir = '';
  let server: Server | null = null;
  let port = 0;
  let haveOpenssl = true;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 's4k-tls-'));
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=chat.signal.org', '-addext', 'subjectAltName=DNS:chat.signal.org', '-addext', 'basicConstraints=critical,CA:FALSE', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    } catch {
      haveOpenssl = false;
      return;
    }
    server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (s) => s.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
    await new Promise<void>((resolve) => (server as Server).listen(0, '127.0.0.1', () => resolve()));
    port = ((server as Server).address() as AddressInfo).port;
  });

  after(() => {
    if (server) server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a self-signed chat.signal.org certificate', async (t) => {
    if (!haveOpenssl) {
      t.skip('openssl is not installed');
      return;
    }
    const connect = nodeConnector(() => ({ host: '127.0.0.1', port }));
    await assert.rejects(connectTls('chat.signal.org', 443, 5000, connect, (h) => new libsignal.TlsConn(h)), (e: TransportError) => {
      assert.equal(e.kind, 'tls');
      assert.match(e.message, /UnknownIssuer/);
      return true;
    });
  });
});
