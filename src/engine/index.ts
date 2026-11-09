/* Entry point for the bundled on-device Signal engine (`window.App.signal`).
 * Bundled by esbuild into `app/vendor/signal-engine.bundle.js` (IIFE, ES2020).
 */

import { fromBase64, toBase64 } from './bytes';
import {
  buildGroupContextV2,
  deriveGroupV2Keys,
} from './groups-v2';
import {
  downloadAndDecryptProfileAvatar,
  fetchAndDecryptProfile,
  resolveSignalUsername,
  uploadOwnProfile,
} from './profiles';
import {
  AttachmentPointer,
  BodyRangeProto,
  BodyRangeStyle,
  ContentProto,
  DataMessage,
  decodeWebSocketMessage,
  encodeWebSocketMessage,
  Envelope,
  FetchLatestType,
  ReceiptType,
  TypingAction,
  VerifiedStateProto,
  WebSocketMessageType,
} from './proto';
import { verifyScannedSafetyNumber } from './protocol/fingerprint';
import {
  generateAndStorePreKeyBundle,
  ProvisioningCallbacks,
  ProvisioningSession,
  startDeviceProvisioning,
} from './provisioning';
import { IndexedDbSignalStore, TrustLevel } from './storage';
import { pullFromStorageService } from './storage-service';
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

function parseDataUri(dataUri: string): {
  contentType: string;
  filename?: string;
  bytes: Uint8Array;
} {
  const comma = dataUri.indexOf(',');
  if (comma < 0) {
    return { contentType: 'application/octet-stream', bytes: fromBase64(dataUri) };
  }
  const header = dataUri.slice(0, comma);
  const b64 = dataUri.slice(comma + 1);
  const mimeMatch = /^data:([^;,]+)/i.exec(header);
  const fnMatch = /;filename=([^;,]+)/i.exec(header);
  return {
    contentType: mimeMatch ? mimeMatch[1] : 'application/octet-stream',
    filename: fnMatch ? fnMatch[1] : undefined,
    bytes: fromBase64(b64),
  };
}

function stylesToBodyRanges(
  styles?: Array<{ start: number; length: number; style: string }>,
  mentions?: Array<{ start: number; length: number; uuid: string }>
): BodyRangeProto[] {
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
  const out: BodyRangeProto[] = (styles || []).map((st) => ({
    start: st.start,
    length: st.length,
    style: mapStyle(st.style),
  }));
  for (const m of mentions || []) {
    out.push({
      start: m.start,
      length: m.length,
      mentionUuid: m.uuid,
    });
  }
  return out;
}

const store = new IndexedDbSignalStore();

function httpJson(
  method: string,
  path: string,
  body: unknown,
  opts?: {
    baseUrl?: string;
    noAuth?: boolean;
    basicAuth?: { username: string; password: string };
    headers?: Record<string, string>;
    timeout?: number;
  }
): Promise<any> {
  const App = getApp();
  return App.http.request(method, path, body, {
    baseUrl: opts?.baseUrl || App.config.serverUrl() || DEFAULT_SIGNAL_SERVER,
    noAuth: opts?.noAuth,
    basicAuth: opts?.basicAuth,
    headers: opts?.headers,
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
  masterKey?: string;
  revision?: number;
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
  return {
    internalId,
    members,
    masterKey: found ? found.masterKey : undefined,
    revision: found ? found.revision : undefined,
  };
}

/**
 * Persist a sender's 32-byte ProfileKey onto `syncedContacts` and in-memory `SignalClient`.
 */
async function recordPeerProfileKey(
  senderUuid?: string,
  senderE164?: string,
  profileKeyBytes?: Uint8Array
): Promise<void> {
  if (!profileKeyBytes || profileKeyBytes.length !== 32) return;
  const peerKey = senderUuid || senderE164;
  if (!peerKey) return;

  client.setPeerProfileKey(peerKey, profileKeyBytes);
  if (senderUuid && senderE164) {
    client.setPeerProfileKey(senderE164, profileKeyBytes);
  }

  const App = getApp();
  const b64 = toBase64(profileKeyBytes);
  const list: Array<any> = (await App.db.kvGet('syncedContacts')) || [];
  let updated = false;
  for (const c of list) {
    if ((senderUuid && c.uuid === senderUuid) || (senderE164 && c.number === senderE164)) {
      if (c.profileKey !== b64) {
        c.profileKey = b64;
        updated = true;
      }
    }
  }
  if (!updated) {
    list.push({
      uuid: senderUuid || '',
      number: senderE164 || '',
      name: senderE164 || senderUuid || '',
      blocked: false,
      expireTimer: 0,
      profileKey: b64,
    });
    updated = true;
  }
  if (updated) {
    await App.db.kvSet('syncedContacts', list);
  }
}

/**
 * Pull contacts, Groups V2 master keys, and account settings from Signal's Storage Service (`GET /v1/storage/manifest`).
 */
async function syncFromStorageService(): Promise<boolean> {
  const App = getApp();
  const serverUrl = App.config.serverUrl() || DEFAULT_SIGNAL_SERVER;
  const res = await pullFromStorageService(store, httpJson, serverUrl);
  if (!res) return false;

  if (res.contacts.length > 0) {
    const existing: Array<any> = (await App.db.kvGet('syncedContacts')) || [];
    const byId = new Map<string, any>();
    for (const c of existing) byId.set(c.uuid || c.number, c);

    for (const sc of res.contacts) {
      const id = sc.aci || sc.e164;
      if (!id) continue;
      if (sc.profileKey && sc.profileKey.length === 32) {
        client.setPeerProfileKey(id, sc.profileKey);
      }
      if (sc.identityKey) {
        await store.saveIdentity(id, sc.identityKey, {
          uuid: sc.aci,
          number: sc.e164,
        });
        if (sc.identityState) {
          await store.setIdentityTrust(id, sc.identityState);
        }
      }
      const prev = byId.get(id) || {};
      const fullName =
        [sc.nicknameGivenName, sc.nicknameFamilyName].filter(Boolean).join(' ') ||
        [sc.givenName, sc.familyName].filter(Boolean).join(' ') ||
        prev.name ||
        sc.username ||
        sc.e164 ||
        sc.aci ||
        '';

      byId.set(id, {
        ...prev,
        uuid: sc.aci || prev.uuid || '',
        number: sc.e164 || prev.number || '',
        name: fullName,
        username: sc.username || prev.username,
        blocked: sc.blocked ?? prev.blocked ?? false,
        profileKey:
          sc.profileKey && sc.profileKey.length === 32
            ? toBase64(sc.profileKey)
            : prev.profileKey,
      });

      if (sc.archived !== undefined && App.store && App.store.setArchived) {
        App.store.setArchived(id, sc.archived);
      }
      if (sc.mutedUntilTimestamp !== undefined && App.store && App.store.setMuted) {
        App.store.setMuted(id, sc.mutedUntilTimestamp > Date.now());
      }
    }
    await App.db.kvSet('syncedContacts', Array.from(byId.values()));
  }

  if (res.groupsV2.length > 0) {
    const existingGroups: Array<any> = (await App.db.kvGet('syncedGroups')) || [];
    const byGrpId = new Map<string, any>();
    for (const g of existingGroups) byGrpId.set(g.internal_id, g);

    for (const gv2 of res.groupsV2) {
      const keys = deriveGroupV2Keys(gv2.masterKey);
      const prev = byGrpId.get(keys.internalId) || {};
      byGrpId.set(keys.internalId, {
        ...prev,
        id: keys.sendId,
        internal_id: keys.internalId,
        masterKey: toBase64(gv2.masterKey),
        name: prev.name || 'Group',
        members: prev.members || [],
        blocked: gv2.blocked ?? prev.blocked ?? false,
        archived: gv2.archived ?? prev.archived ?? false,
      });
    }
    await App.db.kvSet('syncedGroups', Array.from(byGrpId.values()));
  }

  if (res.account) {
    const patch: Record<string, any> = {};
    const fullName = [res.account.givenName, res.account.familyName]
      .filter(Boolean)
      .join(' ');
    if (fullName) patch.profileName = fullName;
    if (res.account.username) patch.username = res.account.username;
    if (res.account.readReceipts !== undefined) {
      patch.sendReadReceipts = res.account.readReceipts;
    }
    if (res.account.typingIndicators !== undefined) {
      patch.typingIndicators = res.account.typingIndicators;
    }
    if (Object.keys(patch).length > 0) {
      App.config.set(patch);
    }
  }

  if (App.store && App.store.refreshDirectory) {
    await App.store.refreshDirectory().catch(() => {});
  }
  return true;
}

async function handleIncomingSyncMessage(
  env: Envelope,
  content: ContentProto
): Promise<void> {
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
      for (const c of parsed) {
        if (c.profileKey) {
          client.setPeerProfileKey(c.uuid || c.number, fromBase64(c.profileKey));
        }
        byId.set(c.uuid || c.number, c);
      }
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

  if (sm.verified) {
    const v = sm.verified;
    const addr = v.destinationUuid || v.destinationE164;
    if (addr) {
      if (v.identityKey) {
        await store.saveIdentity(addr, v.identityKey, {
          uuid: v.destinationUuid,
          number: v.destinationE164,
        });
      }
      const level: TrustLevel =
        v.state === VerifiedStateProto.VERIFIED
          ? 'TRUSTED_VERIFIED'
          : v.state === VerifiedStateProto.UNVERIFIED
          ? 'UNTRUSTED'
          : 'TRUSTED_UNVERIFIED';
      await store.setIdentityTrust(addr, level);
    }
  }

  if (sm.blocked) {
    const b = sm.blocked;
    const blockedNums = new Set(b.numbers || []);
    const blockedUuids = new Set(b.uuids || []);
    const blockedGrpIds = new Set((b.groupIds || []).map((g) => toBase64(g)));

    const contacts: Array<any> = (await App.db.kvGet('syncedContacts')) || [];
    for (const c of contacts) {
      c.blocked =
        (c.number && blockedNums.has(c.number)) ||
        (c.uuid && blockedUuids.has(c.uuid));
    }
    await App.db.kvSet('syncedContacts', contacts);

    const groups: Array<any> = (await App.db.kvGet('syncedGroups')) || [];
    for (const g of groups) {
      g.blocked = blockedGrpIds.has(g.internal_id);
    }
    await App.db.kvSet('syncedGroups', groups);
  }

  if (sm.configuration) {
    const cfg = sm.configuration;
    const patch: Record<string, any> = {};
    if (cfg.readReceipts !== undefined) patch.sendReadReceipts = cfg.readReceipts;
    if (cfg.typingIndicators !== undefined) {
      patch.typingIndicators = cfg.typingIndicators;
    }
    if (Object.keys(patch).length > 0) {
      App.config.set(patch);
    }
  }

  if (
    sm.fetchLatest &&
    sm.fetchLatest.type === FetchLatestType.STORAGE_MANIFEST
  ) {
    syncFromStorageService().catch(() => {});
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

  /** Request contacts & groups sync from primary device AND pull from Signal Storage Service. */
  async requestSync(): Promise<void> {
    await syncFromStorageService().catch(() => {});
    await client.requestInitialSync();
  },

  /** Rotate/replenish SignedPreKey, OneTimePreKeys, and Kyber-1024 PreKeys on the Signal server. */
  async replenishPreKeys(): Promise<void> {
    const acc = await store.getAccount();
    if (!acc) return;
    const keyId = Math.floor(Date.now() / 1000) & 0x7fff;
    const startId = Math.floor(Math.random() * 10000) + 100;
    const bundle = await generateAndStorePreKeyBundle(
      store,
      acc.aciIdentityKeyPair,
      keyId,
      startId,
      50,
      10
    );
    await httpJson('PUT', '/v2/keys?identity=aci', bundle, {
      basicAuth: { username: `${acc.aci}.${acc.deviceId}`, password: acc.password },
    });
    if (acc.pniIdentityKeyPair) {
      const pniBundle = await generateAndStorePreKeyBundle(
        store,
        acc.pniIdentityKeyPair,
        keyId + 1,
        startId + 1000,
        25,
        5
      );
      await httpJson('PUT', '/v2/keys?identity=pni', pniBundle, {
        basicAuth: { username: `${acc.aci}.${acc.deviceId}`, password: acc.password },
      }).catch(() => {});
    }
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
  async processIncomingEnvelope(
    envelopeBytes: Uint8Array
  ): Promise<{ envelope: any } | null> {
    const res = await client.enqueueDecryptEnvelope(envelopeBytes);
    if (!res) return null;

    if (res.content.dataMessage) {
      const dm = res.content.dataMessage;
      if (dm.profileKey) {
        recordPeerProfileKey(
          res.envelope.sourceUuid,
          res.envelope.sourceE164,
          dm.profileKey
        ).catch(() => {});
      }
      if (dm.groupV2 && dm.groupV2.masterKey && dm.groupV2.masterKey.length === 32) {
        const App = getApp();
        const keys = deriveGroupV2Keys(dm.groupV2.masterKey);
        App.db
          .kvGet('syncedGroups')
          .then((groups: Array<any>) => {
            const list = groups || [];
            let found = false;
            for (const g of list) {
              if (g.internal_id === keys.internalId) {
                g.masterKey = toBase64(dm.groupV2!.masterKey!);
                if (dm.groupV2!.revision) g.revision = dm.groupV2!.revision;
                found = true;
              }
            }
            if (!found) {
              list.push({
                id: keys.sendId,
                internal_id: keys.internalId,
                masterKey: toBase64(dm.groupV2!.masterKey!),
                revision: dm.groupV2!.revision || 0,
                name: 'Group',
                members: [
                  res.envelope.sourceUuid || res.envelope.sourceE164 || '',
                ].filter(Boolean),
                blocked: false,
                expireTimer: dm.expireTimer || 0,
              });
            }
            return App.db.kvSet('syncedGroups', list);
          })
          .catch(() => {});
      }
    }

    if (res.content.callMessage && res.content.callMessage.offer) {
      const senderId = res.envelope.sourceUuid || res.envelope.sourceE164;
      if (senderId && res.content.callMessage.offer.id !== undefined) {
        client
          .sendContentToRecipient(
            senderId,
            {
              callMessage: {
                busy: { id: res.content.callMessage.offer.id },
              },
            },
            Date.now(),
            true
          )
          .catch(() => {});
      }
    }

    if (res.content.syncMessage) {
      handleIncomingSyncMessage(res.envelope, res.content).catch(() => {});
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
    mentions?: Array<{ start: number; length: number; uuid: string }>;
  }): Promise<{ timestamp: number }> {
    const App = getApp();
    const ts = Date.now();
    const rawText = payload.message || '';
    let bodyText = rawText;
    let styles: Array<{ start: number; length: number; style: string }> = [];

    if (
      payload.text_mode === 'styled' &&
      rawText &&
      App.util &&
      App.util.parseStyledMarkdown
    ) {
      const parsed = App.util.parseStyledMarkdown(rawText);
      bodyText = parsed.body;
      styles = parsed.styles;
    }

    const bodyRanges = stylesToBodyRanges(styles, payload.mentions);

    const uploadedAttachments: AttachmentPointer[] = [];
    for (const dataUri of payload.base64_attachments || []) {
      const { contentType, filename, bytes } = parseDataUri(dataUri);
      const ext = contentType.split('/')[1] || 'bin';
      const ptr = await client.uploadAttachment(
        bytes,
        contentType,
        filename || `attachment.${ext}`
      );
      if (contentType.startsWith('audio/')) {
        ptr.flags = (ptr.flags || 0) | 0x01; // VOICE_MESSAGE flag
      }
      uploadedAttachments.push(ptr);
    }

    const firstTarget = (payload.recipients && payload.recipients[0]) || '';
    const isGroup = firstTarget.startsWith('group.');
    let targetPeers = payload.recipients || [];
    let groupV1: DataMessage['groupV1'];
    let groupV2: DataMessage['groupV2'];
    let groupInternalId = '';

    if (isGroup) {
      const grp = await resolveGroupRecipients(firstTarget);
      groupInternalId = grp.internalId;
      targetPeers = grp.members;
      if (grp.masterKey) {
        groupV2 = buildGroupContextV2({
          masterKey: grp.masterKey,
          revision: grp.revision,
        });
      } else {
        groupV1 = {
          id: fromBase64(grp.internalId),
          type: 2, // DELIVER
        };
      }
    }

    const convId = isGroup
      ? 'g:' + firstTarget.replace(/^group\./, '')
      : firstTarget;
    const expireTimer =
      App.store && App.store.convExpire ? App.store.convExpire(convId) : 0;

    const acc = await store.getAccount();
    const dm: DataMessage = {
      body: bodyText,
      timestamp: ts,
      expireTimer: expireTimer || undefined,
      profileKey: acc ? acc.profileKey : undefined,
      attachments: uploadedAttachments,
      bodyRanges,
      groupV1,
      groupV2,
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

    if (isGroup && groupInternalId && targetPeers.length > 0) {
      await client.sendGroupContentWithSenderKeys(
        groupInternalId,
        targetPeers,
        content,
        ts
      );
    } else {
      for (const peer of targetPeers) {
        await client.sendContentToRecipient(peer, content, ts);
      }
    }

    // Sync to our own linked devices
    await client.sendSyncMessage(
      {
        syncMessage: {
          sent: {
            destinationE164:
              !isGroup && firstTarget.startsWith('+') ? firstTarget : undefined,
            destinationUuid:
              !isGroup && !firstTarget.startsWith('+') ? firstTarget : undefined,
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
    let groupV2: DataMessage['groupV2'];
    let groupInternalId = '';

    if (isGroup) {
      const grp = await resolveGroupRecipients(recipient);
      groupInternalId = grp.internalId;
      peers = grp.members;
      if (grp.masterKey) {
        groupV2 = buildGroupContextV2({
          masterKey: grp.masterKey,
          revision: grp.revision,
        });
      } else {
        groupV1 = { id: fromBase64(grp.internalId), type: 2 };
      }
    }

    const dm: DataMessage = {
      timestamp: ts,
      groupV1,
      groupV2,
      reaction: {
        emoji,
        remove,
        targetAuthorE164: targetAuthor.startsWith('+') ? targetAuthor : undefined,
        targetAuthorUuid: !targetAuthor.startsWith('+') ? targetAuthor : undefined,
        targetSentTimestamp: targetTimestamp,
      },
    };

    if (isGroup && groupInternalId && peers.length > 0) {
      await client.sendGroupContentWithSenderKeys(
        groupInternalId,
        peers,
        { dataMessage: dm },
        ts
      );
    } else {
      for (const peer of peers) {
        await client.sendContentToRecipient(peer, { dataMessage: dm }, ts);
      }
    }
  },

  async sendRemoteDelete(recipient: string, targetTimestamp: number): Promise<void> {
    const ts = Date.now();
    const isGroup = recipient.startsWith('group.');
    let peers = [recipient];
    let groupV1: DataMessage['groupV1'];
    let groupV2: DataMessage['groupV2'];
    let groupInternalId = '';

    if (isGroup) {
      const grp = await resolveGroupRecipients(recipient);
      groupInternalId = grp.internalId;
      peers = grp.members;
      if (grp.masterKey) {
        groupV2 = buildGroupContextV2({
          masterKey: grp.masterKey,
          revision: grp.revision,
        });
      } else {
        groupV1 = { id: fromBase64(grp.internalId), type: 2 };
      }
    }

    const dm: DataMessage = {
      timestamp: ts,
      groupV1,
      groupV2,
      delete: { targetSentTimestamp: targetTimestamp },
    };

    if (isGroup && groupInternalId && peers.length > 0) {
      await client.sendGroupContentWithSenderKeys(
        groupInternalId,
        peers,
        { dataMessage: dm },
        ts
      );
    } else {
      for (const peer of peers) {
        await client.sendContentToRecipient(peer, { dataMessage: dm }, ts);
      }
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

  async fetchContactAvatarBlob(uuidOrNumber: string): Promise<Blob> {
    const App = getApp();
    const cached = await App.db.getAttachment('avatar:' + uuidOrNumber);
    if (cached && cached.blob) return cached.blob;

    const contacts: Array<any> = (await App.db.kvGet('syncedContacts')) || [];
    const entry = contacts.find(
      (c) => c.uuid === uuidOrNumber || c.number === uuidOrNumber
    );
    const uuid = (entry && entry.uuid) || uuidOrNumber;
    const pkBytes =
      client.getPeerProfileKey(uuid) ||
      (entry && entry.profileKey ? fromBase64(entry.profileKey) : undefined);

    const serverUrl = App.config.serverUrl() || DEFAULT_SIGNAL_SERVER;
    const prof = await fetchAndDecryptProfile(
      store,
      httpJson,
      uuid,
      pkBytes,
      serverUrl
    );
    if (prof && prof.fullName && entry && (!entry.name || entry.name === uuid)) {
      entry.name = prof.fullName;
      await App.db.kvSet('syncedContacts', contacts);
    }
    if (!prof || !prof.avatarUrlPath || !pkBytes) {
      throw new Error('No profile avatar available');
    }

    const avatarBytes = await downloadAndDecryptProfileAvatar(
      httpBinary,
      prof.avatarUrlPath,
      pkBytes
    );
    const ab = avatarBytes.buffer.slice(
      avatarBytes.byteOffset,
      avatarBytes.byteOffset + avatarBytes.byteLength
    ) as ArrayBuffer;
    const blob = new Blob([ab], { type: 'image/jpeg' });
    await App.db.putAttachment('avatar:' + uuidOrNumber, blob, 'image/jpeg');
    return blob;
  },

  async updateOwnProfile(body: { name?: string; about?: string }): Promise<void> {
    const App = getApp();
    const serverUrl = App.config.serverUrl() || DEFAULT_SIGNAL_SERVER;
    await uploadOwnProfile(
      store,
      httpJson,
      {
        name: body.name || App.config.profileName() || 'Signal User',
        about: body.about,
      },
      serverUrl
    ).catch(() => {});
  },

  async lookupUsername(rawUsername: string): Promise<{ uuid: string; username: string } | null> {
    const App = getApp();
    const serverUrl = App.config.serverUrl() || DEFAULT_SIGNAL_SERVER;
    return resolveSignalUsername(store, httpJson, rawUsername, serverUrl);
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

    const idRec = await store.getIdentity(target);
    if (idRec) {
      await client.sendSyncMessage({
        syncMessage: {
          verified: {
            destinationUuid: idRec.uuid || (!target.startsWith('+') ? target : undefined),
            destinationE164: idRec.number || (target.startsWith('+') ? target : undefined),
            identityKey: idRec.publicKey,
            state:
              level === 'TRUSTED_VERIFIED'
                ? VerifiedStateProto.VERIFIED
                : VerifiedStateProto.DEFAULT,
          },
        },
      });
    }
  },

  verifySafetyNumberQr(
    scannedString: string,
    expectedScannableB64: string,
    expectedSafetyNumber: string
  ): boolean {
    try {
      const cleanDigits = scannedString.replace(/\D/g, '');
      if (cleanDigits.length === 60 && cleanDigits === expectedSafetyNumber) {
        return true;
      }
      // Convert binary/latin1 string or base64 from QR scanner into Uint8Array
      let scannedBytes: Uint8Array;
      try {
        scannedBytes = fromBase64(scannedString);
      } catch {
        scannedBytes = new Uint8Array(scannedString.length);
        for (let i = 0; i < scannedString.length; i++) {
          scannedBytes[i] = scannedString.charCodeAt(i) & 0xff;
        }
      }
      const expectedBytes = fromBase64(expectedScannableB64);
      return verifyScannedSafetyNumber(scannedBytes, {
        safetyNumber: expectedSafetyNumber,
        scannableQrBytes: expectedBytes,
      });
    } catch {
      return false;
    }
  },
};

if (typeof window !== 'undefined') {
  const App = getApp();
  App.signal = signalBridge;
}
