import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Http1Client, ResponseParser } from '../src/engine/net/transport/http1';
import { concatBytes } from '../src/engine/bytes';
import { ByteStream, Connector, TransportError } from '../src/engine/net/transport/stream';
import { connectTls, TlsSession } from '../src/engine/net/transport/tls-stream';
import { decodeFrame, encodeFrame, PinnedWebSocket, websocketAccept } from '../src/engine/net/transport/websocket';
import { text, utf8 } from './helpers';

const tick = () => new Promise((r) => setImmediate(r));

/** Server side of an in-memory connection. */
class FakeConn {
  received: Uint8Array = new Uint8Array(0);
  closedByClient = false;
  client: ByteStream;
  onBytes: ((conn: FakeConn) => void) | null = null;

  constructor() {
    const self = this;
    this.client = {
      write(data) {
        self.received = concatBytes(self.received, data.slice());
        if (self.onBytes) setImmediate(() => self.onBytes && self.onBytes(self));
        return true;
      },
      close() {
        self.closedByClient = true;
        const cb = self.client.onClose;
        self.client.onClose = null;
        if (cb) cb(null);
      },
      onData: null,
      onClose: null,
      onDrain: null,
    };
  }

  text(): string {
    return utf8(this.received);
  }

  send(data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? text(data) : data;
    setImmediate(() => {
      if (this.client.onData) this.client.onData(bytes);
    });
  }

  end(err: TransportError | null = null): void {
    setImmediate(() => {
      const cb = this.client.onClose;
      this.client.onClose = null;
      if (cb) cb(err);
    });
  }
}

function fakeServer(onConnect: (conn: FakeConn) => void): { connect: Connector; conns: FakeConn[] } {
  const conns: FakeConn[] = [];
  const connect: Connector = async () => {
    const conn = new FakeConn();
    conns.push(conn);
    onConnect(conn);
    return conn.client;
  };
  return { connect, conns };
}

/** Replies once per complete request head with `reply(head)`. */
function respondTo(conn: FakeConn, reply: (head: string, index: number) => string | Uint8Array) {
  let handled = 0;
  conn.onBytes = (c) => {
    const heads = c.text().split('\r\n\r\n').length - 1;
    while (handled < heads) {
      const head = c.text().split('\r\n\r\n')[handled];
      c.send(reply(head, handled));
      handled++;
    }
  };
}

describe('HTTP/1.1 response parsing', () => {
  it('reads a Content-Length body fed one byte at a time', () => {
    const p = new ResponseParser('GET', 1024);
    const raw = text('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nX-Two: a\r\nx-two: b\r\n\r\nhello');
    let done = false;
    for (const b of raw) done = p.feed(new Uint8Array([b]));
    assert.equal(done, true);
    assert.equal(p.head?.status, 200);
    assert.equal(p.head?.headers['x-two'], 'a, b');
    assert.equal(utf8(p.body()), 'hello');
    assert.equal(p.reusable, true);
  });

  it('reads chunked bodies with extensions and trailers', () => {
    const p = new ResponseParser('GET', 1024);
    const raw = text('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4;ext=1\r\nWiki\r\n5\r\npedia\r\n0\r\nX-Trailer: y\r\n\r\n');
    let done = false;
    for (let i = 0; i < raw.length; i += 3) done = p.feed(raw.subarray(i, i + 3));
    assert.equal(done, true);
    assert.equal(utf8(p.body()), 'Wikipedia');
  });

  it('skips 100 Continue and treats 204 as bodiless', () => {
    const p = new ResponseParser('PUT', 1024);
    assert.equal(p.feed(text('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n')), true);
    assert.equal(p.head?.status, 204);
    assert.equal(p.body().length, 0);
  });

  it('reads until close when there is no length, and marks the connection not reusable', () => {
    const p = new ResponseParser('GET', 1024);
    assert.equal(p.feed(text('HTTP/1.1 200 OK\r\n\r\npart')), false);
    assert.equal(p.end(), true);
    assert.equal(utf8(p.body()), 'part');
    assert.equal(p.reusable, false);
  });

  it('rejects oversized and malformed responses', () => {
    assert.throws(() => new ResponseParser('GET', 10).feed(text('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n')), /too large/);
    assert.throws(() => new ResponseParser('GET', 10).feed(text('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n')), /chunk size/);
    assert.throws(() => new ResponseParser('GET', 10).feed(text('HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n')), /Content-Length/);
    assert.throws(() => new ResponseParser('GET', 10).feed(text('SMTP ready\r\n\r\n')), /status line/);
    assert.throws(() => new ResponseParser('GET', 10).feed(text('HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n')), /transfer encoding/);
  });
});

describe('HTTP/1.1 client', () => {
  it('sends Host, Content-Length, and the body, and parses the reply', async () => {
    const { connect, conns } = fakeServer((c) => respondTo(c, () => 'HTTP/1.1 201 Created\r\nLocation: /next\r\nContent-Length: 2\r\n\r\nok'));
    const client = new Http1Client(connect, { userAgent: 'Test/1' });
    const res = await client.request({ method: 'put', url: 'https://chat.signal.org/v1/x?y=1', headers: { 'X-A': 'b' }, body: text('{}') });
    assert.equal(res.status, 201);
    assert.equal(res.headers.location, '/next');
    assert.equal(utf8(res.body), 'ok');
    const sent = conns[0].text();
    assert.match(sent, /^PUT \/v1\/x\?y=1 HTTP\/1\.1\r\nHost: chat\.signal\.org\r\n/);
    assert.match(sent, /\r\nUser-Agent: Test\/1\r\n/);
    assert.match(sent, /\r\nX-A: b\r\n/);
    assert.match(sent, /\r\nContent-Length: 2\r\n\r\n\{\}$/);
  });

  it('reuses a kept-alive connection, and opens a new one after Connection: close', async () => {
    const { connect, conns } = fakeServer((c) =>
      respondTo(c, (_h, i) => (i === 1 ? 'HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 1\r\n\r\nb' : 'HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\na'))
    );
    const client = new Http1Client(connect);
    assert.equal(utf8((await client.request({ method: 'GET', url: 'https://cdn.signal.org/1' })).body), 'a');
    assert.equal(utf8((await client.request({ method: 'GET', url: 'https://cdn.signal.org/2' })).body), 'b');
    assert.equal(conns.length, 1);
    assert.equal(utf8((await client.request({ method: 'GET', url: 'https://cdn.signal.org/3' })).body), 'a');
    assert.equal(conns.length, 2);
    client.closeAll();
  });

  it('retries once when a pooled connection was closed by the server', async () => {
    const { connect, conns } = fakeServer((c) => respondTo(c, () => 'HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nz'));
    const client = new Http1Client(connect);
    await client.request({ method: 'GET', url: 'https://chat.signal.org/a' });
    conns[0].onBytes = (c) => c.end();
    const res = await client.request({ method: 'GET', url: 'https://chat.signal.org/b' });
    assert.equal(utf8(res.body), 'z');
    assert.equal(conns.length, 2);
    client.closeAll();
  });

  it('runs at most maxPerHost requests per host at once and queues the rest onto pooled connections', async () => {
    const { connect, conns } = fakeServer((c) => respondTo(c, () => 'HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nq'));
    const client = new Http1Client(connect, { maxPerHost: 2 });
    const results = await Promise.all(
      Array.from({ length: 7 }, (_, i) => client.request({ method: 'GET', url: `https://cdn.signal.org/${i}` }))
    );
    assert.deepEqual(results.map((r) => utf8(r.body)), Array(7).fill('q'));
    assert.equal(conns.length, 2);
    await client.request({ method: 'GET', url: 'https://cdn2.signal.org/other-host' });
    assert.equal(conns.length, 3);
    client.closeAll();
  });

  it('fails a truncated body and times out a silent server', async () => {
    const truncated = fakeServer((c) => (c.onBytes = (s) => {
      s.send('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc');
      s.end();
    }));
    await assert.rejects(new Http1Client(truncated.connect).request({ method: 'GET', url: 'https://chat.signal.org/' }), (e: TransportError) => e.kind === 'network');
    const silent = fakeServer(() => {});
    await assert.rejects(new Http1Client(silent.connect).request({ method: 'GET', url: 'https://chat.signal.org/', timeoutMs: 50 }), (e: TransportError) => e.kind === 'timeout');
  });

  it('refuses header injection and non-https URLs', async () => {
    const { connect } = fakeServer(() => {});
    const client = new Http1Client(connect);
    await assert.rejects(client.request({ method: 'GET', url: 'https://chat.signal.org/', headers: { 'X-A': 'b\r\nEvil: 1' } }), /invalid value/);
    await assert.rejects(client.request({ method: 'GET', url: 'https://chat.signal.org/', headers: { 'Bad Name': 'x' } }), /invalid header name/);
    await assert.rejects(client.request({ method: 'GET', url: 'http://chat.signal.org/' }), /scheme/);
  });
});

describe('TLS stream', () => {
  it('does not touch the session after a data handler closes the stream', async () => {
    let freed = false;
    let handshakeDone = false;
    let unread: Uint8Array = new Uint8Array(0);
    const guard = () => {
      if (freed) throw new Error('null pointer passed to rust');
    };
    const session: TlsSession = {
      feed(data) {
        guard();
        if (!handshakeDone) handshakeDone = true;
        else unread = data;
      },
      takeOutgoing: () => (guard(), new Uint8Array(0)),
      write: () => guard(),
      read() {
        guard();
        const out = unread;
        unread = new Uint8Array(0);
        return out;
      },
      isHandshaking: () => (guard(), !handshakeDone),
      peerClosed: () => (guard(), false),
      closeNotify: () => guard(),
      free: () => {
        freed = true;
      },
    };
    const conn = new FakeConn();
    const stream = await new Promise<ByteStream>((resolve, reject) => {
      connectTls('chat.signal.org', 443, 1000, async () => conn.client, () => session).then(resolve, reject);
      conn.send('server hello');
    });
    let closedErr: TransportError | null | undefined;
    stream.onClose = (err) => (closedErr = err);
    stream.onData = () => stream.close();
    const errors: unknown[] = [];
    process.once('uncaughtException', (e) => errors.push(e));
    conn.send('application data');
    await until(() => closedErr !== undefined);
    await tick();
    assert.equal(closedErr, null);
    assert.equal(freed, true);
    assert.deepEqual(errors, []);
  });
});

/** Decodes one masked client frame. */
function decodeClientFrame(buf: Uint8Array): { opcode: number; payload: Uint8Array; masked: boolean; length: number } | null {
  if (buf.length < 2) return null;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    len = (buf[2] << 8) | buf[3];
    off = 4;
  } else if (len === 127) {
    len = buf[6] * 2 ** 24 + (buf[7] << 16) + (buf[8] << 8) + buf[9];
    off = 10;
  }
  const mask = buf.subarray(off, off + 4);
  off += masked ? 4 : 0;
  if (buf.length < off + len) return null;
  const payload = buf.slice(off, off + len);
  if (masked) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
  return { opcode: buf[0] & 0x0f, payload, masked, length: off + len };
}

function serverFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const head = payload.length < 126 ? [((fin ? 0x80 : 0) | opcode), payload.length] : [((fin ? 0x80 : 0) | opcode), 126, payload.length >> 8, payload.length & 0xff];
  return concatBytes(new Uint8Array(head), payload);
}

/** Completes the upgrade, then collects client frames sent after it. */
function wsServer(opts: { status?: number; badAccept?: boolean } = {}) {
  const frames: Array<{ opcode: number; payload: Uint8Array; masked: boolean }> = [];
  let request = '';
  const server = fakeServer((c) => {
    let upgraded = false;
    let offset = 0;
    c.onBytes = (s) => {
      if (!upgraded) {
        const text = s.text();
        const end = text.indexOf('\r\n\r\n');
        if (end < 0) return;
        request = text.slice(0, end);
        upgraded = true;
        offset = end + 4;
        if (opts.status && opts.status !== 101) {
          s.send(`HTTP/1.1 ${opts.status} Nope\r\nContent-Length: 0\r\n\r\n`);
          return;
        }
        const key = /Sec-WebSocket-Key: (.+)\r?$/m.exec(request)?.[1].trim() || '';
        const accept = opts.badAccept ? 'wrong' : websocketAccept(key);
        s.send(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      }
      for (;;) {
        const f = decodeClientFrame(s.received.subarray(offset));
        if (!f) return;
        offset += f.length;
        frames.push(f);
      }
    };
  });
  return { ...server, frames, request: () => request };
}

function openSocket(connect: Connector, url = 'wss://chat.signal.org/v1/websocket/?login=a&password=secret') {
  const ws = new PinnedWebSocket(url, connect);
  const events: string[] = [];
  const messages: Array<ArrayBuffer | string> = [];
  let closeEvt: { code: number; reason: string; wasClean: boolean } | null = null;
  ws.onopen = () => events.push('open');
  ws.onerror = () => events.push('error');
  ws.onmessage = (e) => messages.push(e.data);
  ws.onclose = (e) => {
    events.push('close');
    closeEvt = e;
  };
  return { ws, events, messages, closed: () => closeEvt };
}

async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met');
    await tick();
  }
}

describe('WebSocket client', () => {
  it('upgrades, sends masked frames, and delivers binary messages', async () => {
    const srv = wsServer();
    const s = openSocket(srv.connect);
    await until(() => s.events.includes('open'));
    assert.equal(s.ws.readyState, PinnedWebSocket.OPEN);
    assert.match(srv.request(), /^GET \/v1\/websocket\/\?login=a&password=secret HTTP\/1\.1\r\nHost: chat\.signal\.org/);
    assert.match(srv.request(), /\r\nSec-WebSocket-Version: 13/);

    s.ws.send(new Uint8Array([1, 2, 3]));
    await until(() => srv.frames.length === 1);
    assert.equal(srv.frames[0].masked, true);
    assert.equal(srv.frames[0].opcode, 2);
    assert.deepEqual([...srv.frames[0].payload], [1, 2, 3]);

    srv.conns[0].send(serverFrame(2, new Uint8Array([9, 8])));
    await until(() => s.messages.length === 1);
    assert.deepEqual([...new Uint8Array(s.messages[0] as ArrayBuffer)], [9, 8]);
  });

  it('sends caller headers such as Authorization on the upgrade request', async () => {
    const srv = wsServer();
    const ws = new PinnedWebSocket('wss://chat.signal.org/v1/websocket/?agent=OWD', srv.connect, { headers: { Authorization: 'Basic YTpi' } });
    let opened = false;
    ws.onopen = () => (opened = true);
    await until(() => opened);
    assert.match(srv.request(), /^GET \/v1\/websocket\/\?agent=OWD HTTP\/1\.1\r\n/);
    assert.match(srv.request(), /\r\nAuthorization: Basic YTpi\r\n/);
    ws.close();
  });

  it('reassembles fragmented messages and answers pings', async () => {
    const srv = wsServer();
    const s = openSocket(srv.connect);
    await until(() => s.events.includes('open'));
    srv.conns[0].send(concatBytes(serverFrame(2, text('ab'), false), concatBytes(serverFrame(9, text('p')), serverFrame(0, text('cd')))));
    await until(() => s.messages.length === 1 && srv.frames.length === 1);
    assert.equal(utf8(new Uint8Array(s.messages[0] as ArrayBuffer)), 'abcd');
    assert.equal(srv.frames[0].opcode, 0xa);
    assert.equal(utf8(srv.frames[0].payload), 'p');
  });

  it('reports the server close code and echoes the close', async () => {
    const srv = wsServer();
    const s = openSocket(srv.connect);
    await until(() => s.events.includes('open'));
    srv.conns[0].send(serverFrame(8, new Uint8Array([0x0f, 0xa1, ...text('unauthorized')])));
    await until(() => s.closed() !== null && srv.frames.length === 1);
    assert.deepEqual(s.closed(), { code: 4001, reason: 'unauthorized', wasClean: true });
    assert.equal(srv.frames[0].opcode, 8);
    assert.equal(srv.conns[0].closedByClient, true);
  });

  it('maps a 401 upgrade to 4001 and a bad accept key to 1002', async () => {
    const denied = openSocket(wsServer({ status: 401 }).connect);
    await until(() => denied.closed() !== null);
    assert.equal(denied.closed()?.code, 4001);
    assert.deepEqual(denied.events, ['error', 'close']);

    const bad = openSocket(wsServer({ badAccept: true }).connect);
    await until(() => bad.closed() !== null);
    assert.equal(bad.closed()?.code, 1002);
  });

  it('closes with 1002 on a masked server frame', async () => {
    const srv = wsServer();
    const s = openSocket(srv.connect);
    await until(() => s.events.includes('open'));
    srv.conns[0].send(encodeFrame(2, text('x')));
    await until(() => s.closed() !== null);
    assert.equal(s.closed()?.code, 1002);
  });

  it('closes with 1015 when the TLS layer fails, without leaking the URL', async () => {
    const failing: Connector = () => Promise.reject(new TransportError('tls', 'secure connection failed: invalid peer certificate: UnknownIssuer'));
    const s = openSocket(failing);
    await until(() => s.closed() !== null);
    assert.equal(s.closed()?.code, 1015);
    assert.match(s.closed()?.reason || '', /UnknownIssuer/);
    assert.doesNotMatch(s.closed()?.reason || '', /secret/);
  });

  it('closes cleanly when the client closes', async () => {
    const srv = wsServer();
    const s = openSocket(srv.connect);
    await until(() => s.events.includes('open'));
    s.ws.close(1000, 'bye');
    await until(() => srv.frames.length === 1);
    assert.equal(srv.frames[0].opcode, 8);
    srv.conns[0].send(serverFrame(8, new Uint8Array([0x03, 0xe8])));
    await until(() => s.closed() !== null);
    assert.equal(s.closed()?.code, 1000);
    assert.equal(s.ws.readyState, PinnedWebSocket.CLOSED);
  });

  it('encodes and decodes frames of every length class', () => {
    for (const len of [0, 125, 126, 65535, 65536, 70000]) {
      const payload = new Uint8Array(len).map((_, i) => i & 0xff);
      const f = decodeClientFrame(encodeFrame(2, payload));
      assert.ok(f);
      assert.equal(f.payload.length, len);
      assert.deepEqual(f.payload, payload);
      const server = decodeFrame(len < 126 ? serverFrame(2, payload) : concatBytes(new Uint8Array([0x82, 127, 0, 0, 0, 0, len >>> 24, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]), payload));
      assert.equal(server?.payload.length, len);
    }
    assert.throws(() => decodeFrame(new Uint8Array([0x82, 127, 1, 0, 0, 0, 0, 0, 0, 0])), /too large/);
    assert.throws(() => decodeFrame(new Uint8Array([0x89, 126, 0, 200])), /control frame/);
  });
});
