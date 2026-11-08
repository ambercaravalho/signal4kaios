/* Entry point for the bundled on-device Signal engine (`window.App.signal`).
 * Bundled by esbuild into `app/vendor/signal-engine.bundle.js` (IIFE, ES2020).
 */

import { fromBase64, toBase64 } from './bytes';
import {
  AttachmentPointer,
  BodyRangeProto,
  BodyRangeStyle,
  ContentProto,
  DataMessage,
  decodeWebSocketMessage,
  encodeWebSocketMessage,
  ReceiptType,
  TypingAction,
  WebSocketMessageType,
} from './proto';
import {
  generateAndStorePreKeyBundle,
  ProvisioningCallbacks,
  ProvisioningSession,
  startDeviceProvisioning,
} from './provisioning';
import { IndexedDbSignalStore, TrustLevel } from './storage';
import {
  DEFAULT_SIGNAL_SERVER,
  parseContactsSyncBlob,
  parseGroupsSyncBlob,
  SignalClient,
} from './transport';

function getApp(): any {
  const g = globalThis as any;
  g.App = g.App || { screens: {} };
  return g.App;
}

function parseDataUri(dataUri: string): { contentType: string; bytes: Uint8Array } {
  const comma = dataUri.indexOf(',');
  if (comma < 0) {
    return { contentType: 'application/octet-stream', bytes: fromBase64(dataUri) };
  }
  const header = dataUri.slice(0, comma);
  const b64 = dataUri.slice(comma + 1);
  const match = /^data:([^;]+)/i.exec(header);
  return {
    contentType: match ? match[1] : 'application/octet-stream',
    bytes: fromBase64(b64),
  };
}

function stylesToBodyRanges(
  styles?: Array<{ start: number; length: number; style: string }>
): BodyRangeProto[] {
  if (!styles || !styles.length) return [];
  const mapStyle = (s: string): BodyRangeStyle => {
    switch ((s || '').toUpperCase()) {
      case 'BOLD': return BodyRangeStyle.BOLD;
      case 'ITALIC': return BodyRangeStyle.ITALIC;
      case 'SPOILER': return BodyRangeStyle.SPOILER;
      case 'STRIKETHROUGH': return BodyRangeStyle.STRIKETHROUGH;
      case 'MONOSPACE': return BodyRangeStyle.MONOSPACE;
      default: return BodyRangeStyle.NONE;
    }
  };
  return styles.map((st) => ({
    start: st.start,
    length: st.length,
    style: mapStyle(st.style),
  }));
}

const store = new IndexedDbSignalStore();

function httpJson(
  method: string,
  path: string,
  body: unknown,
  opts?: {
    baseUrl?: string;
    basicAuth?: { username: string; password: string };
    timeout?: number;
  }
): Promise<any> {
  const App = getApp();
  return App.http.request(method, path, body, {
    baseUrl: opts?.baseUrl || App.config.serverUrl() || DEFAULT_SIGNAL_SERVER,
    basicAuth: opts?.basicAuth,
    timeout: opts?.timeout,
  });
}

function httpBinary(
  method: string,
  url: string,
  body?: Uint8Array | null,
  headers?: Record<string, string>,
  timeout?: number
): Promise<Uint8Array> {
  const App = getApp();
  return App.http.rawBinary(method, url, body, headers, timeout);
}

const client = new SignalClient(store, httpJson, httpBinary);

async function resolveGroupRecipients(groupSendId: string): Promise<{
  internalId: string;
  members: string[];
}> {
  const App = getApp();
  const internalId = groupSendId.replace(/^group\./, '');
  const syncedGroups: Array<any> = (await App.db.kvGet('syncedGroups')) || [];
  const found = syncedGroups.find(
    (g) => g.id === groupSendId || g.internal_id === internalId
  );
  const selfNum = App.config.number();
  const selfAci = App.config.aci ? App.config.aci() : '';
  const members = ((found && found.members) || []).filter(
    (m: string) => m && m !== selfNum && m !== selfAci
  );
  return { internalId, members };
}

async function handleIncomingSyncBlobs(content: ContentProto): Promise<void> {
  const App = getApp();
  const sm = content.syncMessage;
  if (!sm) return;

  if (sm.contacts && sm.contacts.blob) {
    try {
      const { bytes } = await client.downloadAttachment(sm.contacts.blob);
      const parsed = parseContactsSyncBlob(bytes);
      const existing: Array<any> = (await App.db.kvGet('syncedContacts')) || [];
      const byId = new Map<string, any>();
      for (const c of existing) byId.set(c.uuid || c.number, c);
      for (const c of parsed) byId.set(c.uuid || c.number, c);
      await App.db.kvSet('syncedContacts', Array.from(byId.values()));
      if (App.store && App.store.refreshDirectory) {
        App.store.refreshDirectory().catch(() => {});
      }
    } catch (e: any) {
      App.util.dbg('sync contacts blob failed: ' + (e && e.message));
    }
  }

  if (sm.groups && sm.groups.blob) {
    try {
      const { bytes } = await client.downloadAttachment(sm.groups.blob);
      const parsed = parseGroupsSyncBlob(bytes);
      const existing: Array<any> = (await App.db.kvGet('syncedGroups')) || [];
      const byId = new Map<string, any>();
      for (const g of existing) byId.set(g.internal_id, g);
      for (const g of parsed) byId.set(g.internal_id, g);
      await App.db.kvSet('syncedGroups', Array.from(byId.values()));
      if (App.store && App.store.refreshDirectory) {
        App.store.refreshDirectory().catch(() => {});
      }
    } catch (e: any) {
      App.util.dbg('sync groups blob failed: ' + (e && e.message));
    }
  }
}

export const signalBridge = {
  store,
  client,

  /** Start QR code provisioning for linking this KaiOS phone as a Signal secondary device. */
  startProvisioning(
    deviceName: string,
    callbacks: ProvisioningCallbacks
  ): ProvisioningSession {
    const App = getApp();
    const serverUrl = App.config.serverUrl() || DEFAULT_SIGNAL_SERVER;
    const wsUrl = serverUrl.replace(/^http/, 'ws');
    return startDeviceProvisioning(store, httpJson, deviceName, callbacks, {
      httpUrl: serverUrl,
      wsUrl,
    });
  },

  /** Request contacts & groups sync from the primary device. */
  requestSync(): Promise<void> {
    return client.requestInitialSync();
  },

  /** Rotate/replenish SignedPreKey and OneTimePreKeys on the Signal server. */
  async replenishPreKeys(): Promise<void> {
    const acc = await store.getAccount();
    if (!acc) return;
    const bundle = await generateAndStorePreKeyBundle(
      store,
      acc.aciIdentityKeyPair,
      Math.floor(Date.now() / 1000) & 0x7fff,
      Math.floor(Math.random() * 10000) + 100,
      50
    );
    await httpJson('PUT', '/v2/keys', bundle, {
      basicAuth: { username: `${acc.aci}.${acc.deviceId}`, password: acc.password },
    });
  },

  /** Decode a binary WebSocket frame from `wss://chat.signal.org/v1/websocket/`. */
  decodeWsFrame(buf: ArrayBuffer | Uint8Array) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return decodeWebSocketMessage(u8);
  },

  /** Encode a WebSocket response ACK (`200 OK`) for a processed request ID. */
  encodeWsAck(id: bigint, status = 200, message = 'OK'): Uint8Array {
    return encodeWebSocketMessage({
      type: WebSocketMessageType.RESPONSE,
      response: { id, status, message, headers: [] },
    });
  },

  /** Encode a WebSocket keepalive request (`GET /v1/keepalive`). */
  encodeWsKeepalive(): Uint8Array {
    return encodeWebSocketMessage({
      type: WebSocketMessageType.REQUEST,
      request: {
        verb: 'GET',
        path: '/v1/keepalive',
        id: BigInt(Date.now()),
        headers: [],
      },
    });
  },

  /**
   * Decrypt a binary Signal `Envelope` from a WebSocket `/api/v1/message` request
   * and return the JSON frame ready for `App.store.ingestRaw`.
   */
  async processIncomingEnvelope(envelopeBytes: Uint8Array): Promise<{ envelope: any } | null> {
    const res = await client.enqueueDecryptEnvelope(envelopeBytes);
    if (!res) return null;
    if (res.content.syncMessage) {
      handleIncomingSyncBlobs(res.content).catch(() => {});
    }
    return res.normalizedFrame;
  },

  /**
   * Send an outgoing message, edit, or attachment (`App.api.send` equivalent).
   */
  async send(payload: {
    recipients: string[];
    message?: string;
    text_mode?: string;
    quote_timestamp?: number;
    quote_author?: string;
    quote_message?: string;
    base64_attachments?: string[];
    edit_timestamp?: number;
  }): Promise<{ timestamp: number }> {
    const App = getApp();
    const ts = Date.now();
    const rawText = payload.message || '';
    let bodyText = rawText;
    let bodyRanges: BodyRangeProto[] = [];

    if (payload.text_mode === 'styled' && rawText && App.util && App.util.parseStyledMarkdown) {
      const parsed = App.util.parseStyledMarkdown(rawText);
      bodyText = parsed.body;
      bodyRanges = stylesToBodyRanges(parsed.styles);
    }

    const uploadedAttachments: AttachmentPointer[] = [];
    for (const dataUri of payload.base64_attachments || []) {
      const { contentType, bytes } = parseDataUri(dataUri);
      const ext = contentType.split('/')[1] || 'bin';
      const ptr = await client.uploadAttachment(bytes, contentType, `attachment.${ext}`);
      uploadedAttachments.push(ptr);
    }

    const firstTarget = (payload.recipients && payload.recipients[0]) || '';
    const isGroup = firstTarget.startsWith('group.');
    let targetPeers = payload.recipients || [];
    let groupV1: DataMessage['groupV1'];

    if (isGroup) {
      const grp = await resolveGroupRecipients(firstTarget);
      targetPeers = grp.members;
      groupV1 = {
        id: fromBase64(grp.internalId),
        type: 2, // DELIVER
      };
    }

    const convId = isGroup
      ? 'g:' + firstTarget.replace(/^group\./, '')
      : firstTarget;
    const expireTimer = App.store && App.store.convExpire ? App.store.convExpire(convId) : 0;

    const dm: DataMessage = {
      body: bodyText,
      timestamp: ts,
      expireTimer: expireTimer || undefined,
      attachments: uploadedAttachments,
      bodyRanges,
      groupV1,
    };

    if (payload.quote_timestamp) {
      const qa = payload.quote_author || '';
      dm.quote = {
        id: payload.quote_timestamp,
        authorE164: qa.startsWith('+') ? qa : undefined,
        authorUuid: !qa.startsWith('+') ? qa : undefined,
        text: payload.quote_message || '',
      };
    }

    const content: ContentProto = payload.edit_timestamp
      ? {
          editMessage: {
            targetSentTimestamp: payload.edit_timestamp,
            dataMessage: dm,
          },
        }
      : { dataMessage: dm };

    for (const peer of targetPeers) {
      await client.sendContentToRecipient(peer, content, ts);
    }

    // Sync to our own linked devices
    await client.sendSyncMessage(
      {
        syncMessage: {
          sent: {
            destinationE164: !isGroup && firstTarget.startsWith('+') ? firstTarget : undefined,
            destinationUuid: !isGroup && !firstTarget.startsWith('+') ? firstTarget : undefined,
            timestamp: ts,
            message: payload.edit_timestamp ? undefined : dm,
            editMessage: payload.edit_timestamp
              ? { targetSentTimestamp: payload.edit_timestamp, dataMessage: dm }
              : undefined,
          },
        },
      },
      ts
    );

    return { timestamp: ts };
  },

  async sendReaction(
    recipient: string,
    targetAuthor: string,
    targetTimestamp: number,
    emoji: string,
    remove: boolean
  ): Promise<void> {
    const ts = Date.now();
    const isGroup = recipient.startsWith('group.');
    let peers = [recipient];
    let groupV1: DataMessage['groupV1'];

    if (isGroup) {
      const grp = await resolveGroupRecipients(recipient);
      peers = grp.members;
      groupV1 = { id: fromBase64(grp.internalId), type: 2 };
    }

    const dm: DataMessage = {
      timestamp: ts,
      groupV1,
      reaction: {
        emoji,
        remove,
        targetAuthorE164: targetAuthor.startsWith('+') ? targetAuthor : undefined,
        targetAuthorUuid: !targetAuthor.startsWith('+') ? targetAuthor : undefined,
        targetSentTimestamp: targetTimestamp,
      },
    };

    for (const peer of peers) {
      await client.sendContentToRecipient(peer, { dataMessage: dm }, ts);
    }
  },

  async sendRemoteDelete(recipient: string, targetTimestamp: number): Promise<void> {
    const ts = Date.now();
    const isGroup = recipient.startsWith('group.');
    let peers = [recipient];
    let groupV1: DataMessage['groupV1'];

    if (isGroup) {
      const grp = await resolveGroupRecipients(recipient);
      peers = grp.members;
      groupV1 = { id: fromBase64(grp.internalId), type: 2 };
    }

    const dm: DataMessage = {
      timestamp: ts,
      groupV1,
      delete: { targetSentTimestamp: targetTimestamp },
    };

    for (const peer of peers) {
      await client.sendContentToRecipient(peer, { dataMessage: dm }, ts);
    }
  },

  async sendTyping(recipient: string, started: boolean): Promise<void> {
    const ts = Date.now();
    const isGroup = recipient.startsWith('group.');
    let peers = [recipient];
    let groupId: Uint8Array | undefined;

    if (isGroup) {
      const grp = await resolveGroupRecipients(recipient);
      peers = grp.members;
      groupId = fromBase64(grp.internalId);
    }

    const content: ContentProto = {
      typingMessage: {
        timestamp: ts,
        action: started ? TypingAction.STARTED : TypingAction.STOPPED,
        groupId,
      },
    };

    for (const peer of peers) {
      await client.sendContentToRecipient(peer, content, ts, true);
    }
  },

  async sendReadReceipt(recipient: string, timestamp: number): Promise<void> {
    const now = Date.now();
    await client.sendContentToRecipient(
      recipient,
      {
        receiptMessage: {
          type: ReceiptType.READ,
          timestamp: [timestamp],
        },
      },
      now
    );
    await client.sendSyncMessage(
      {
        syncMessage: {
          read: [
            {
              senderE164: recipient.startsWith('+') ? recipient : undefined,
              senderUuid: !recipient.startsWith('+') ? recipient : undefined,
              timestamp,
            },
          ],
        },
      },
      now
    );
  },

  async downloadAttachmentBlob(id: string): Promise<Blob> {
    const { bytes, contentType } = await client.downloadAttachment(id);
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    return new Blob([ab], { type: contentType });
  },

  async identities() {
    return client.listIdentitiesWithSafetyNumbers();
  },

  async trustIdentity(
    target: string,
    opts?: { verified_safety_number?: string; trust_all_known_keys?: boolean }
  ): Promise<void> {
    const level: TrustLevel = opts?.verified_safety_number
      ? 'TRUSTED_VERIFIED'
      : 'TRUSTED_UNVERIFIED';
    await store.setIdentityTrust(target, level);
  },
};

if (typeof window !== 'undefined') {
  const App = getApp();
  App.signal = signalBridge;
}
