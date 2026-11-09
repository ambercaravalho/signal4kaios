/* Live checks against Signal's production servers (`npm run test:live`). Not part of `npm test`: they need the network and send no credentials. */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { libsignal } from '../../src/engine/protocol/libsignal';
import { decodeWebSocketMessage } from '../../src/engine/net/proto';
import { WebSocketMessage_Type } from '../../src/engine/gen/chat_websocket_pb';
import { Http1Client } from '../../src/engine/net/transport/http1';
import { Connector, TransportError } from '../../src/engine/net/transport/stream';
import { connectTls } from '../../src/engine/net/transport/tls-stream';
import { PinnedWebSocket } from '../../src/engine/net/transport/websocket';
import { loadWasmForTests, nodeConnector } from '../support';

const raw = nodeConnector();
const pinned: Connector = (host, port, timeoutMs) => connectTls(host, port, timeoutMs, raw, (h) => new libsignal.TlsConn(h));

before(() => {
  loadWasmForTests();
});

describe('Signal servers over pinned TLS', () => {
  it('opens the provisioning WebSocket and receives an address', async () => {
    const frame = await new Promise<Uint8Array>((resolve, reject) => {
      const ws = new PinnedWebSocket('wss://chat.signal.org/v1/websocket/provisioning/?agent=OWD', pinned);
      ws.onmessage = (e) => {
        resolve(new Uint8Array(e.data as ArrayBuffer));
        ws.close();
      };
      ws.onclose = (e) => reject(new Error(`closed ${e.code} ${e.reason}`));
    });
    const msg = decodeWebSocketMessage(frame);
    assert.equal(msg.type, WebSocketMessage_Type.REQUEST);
    assert.equal(msg.request?.path, '/v1/address');
  });

  it('gets an HTTP answer from chat and storage', async () => {
    const http = new Http1Client(pinned);
    const chat = await http.request({ method: 'GET', url: 'https://chat.signal.org/v1/accounts/whoami', timeoutMs: 15000 });
    assert.equal(chat.status, 401);
    const storage = await http.request({ method: 'GET', url: 'https://storage.signal.org/v1/storage/manifest', timeoutMs: 15000 });
    assert.ok(storage.status >= 400 && storage.status < 500, `storage answered ${storage.status}`);
    http.closeAll();
  });

  it('rejects a server whose certificate is not from Signal', async () => {
    const elsewhere = nodeConnector(() => ({ host: 'example.com', port: 443 }));
    await assert.rejects(connectTls('chat.signal.org', 443, 15000, elsewhere, (h) => new libsignal.TlsConn(h)), (e: TransportError) => e.kind === 'tls');
  });
});
