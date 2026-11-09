/* Entry point for the bundled on-device Signal engine (`window.App.signal`).
 * Bundled by esbuild into `app/vendor/signal-engine.bundle.js` (IIFE, ES2020).
 */

import type { MessageInitShape } from '@bufbuild/protobuf';

import { fromBase64, toBase64 } from './bytes';
import {
  AttachmentPointer,
  AttachmentPointer_Flags,
  BodyRange_Style,
  BodyRangeSchema,
  Content,
  ContentSchema,
  DataMessage,
  DataMessageSchema,
  ReceiptMessage_Type,
  SyncMessage_FetchLatest_Type,
  TypingMessage_Action,
  Verified_State,
} from './gen/SignalService_pb';
import { buildGroupContextV2, deriveGroupV2Keys, fetchGroupState } from './groups-v2';
import { libsignal, loadLibsignal } from './libsignal';
import { downloadAndDecryptProfileAvatar, fetchAndDecryptProfile, resolveSignalUsername, uploadOwnProfile } from './profiles';
import { generatePreKeyUpload } from './prekeys';
import { create, decodeWebSocketMessage, encodeWebSocketRequest, encodeWebSocketResponse } from './proto';
import { compareScannedSafetyNumber } from './protocol';
import { ProvisioningCallbacks, ProvisioningSession, startDeviceProvisioning } from './provisioning';
import { IndexedDbSignalStore, TrustLevel } from './storage';
import { pullFromStorageService } from './storage-service';
import { DEFAULT_SIGNAL_SERVER, IncomingEnvelope, isAci, parseContactsSyncBlob, SignalClient } from './transport';

type DataMessageInit = MessageInitShape<typeof DataMessageSchema>;
type BodyRangeInit = MessageInitShape<typeof BodyRangeSchema>;

function getApp(): any {
  const g = globalThis as any;
  g.App = g.App || { screens: {} };
  return g.App;
}

function parseDataUri(dataUri: string): { contentType: string; filename?: string; bytes: Uint8Array } {
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
): BodyRangeInit[] {
  const mapStyle = (s: string): BodyRange_Style => {
    switch ((s || '').toUpperCase()) {
      case 'BOLD': return BodyRange_Style.BOLD;
      case 'ITALIC': return BodyRange_Style.ITALIC;
      case 'SPOILER': return BodyRange_Style.SPOILER;
      case 'STRIKETHROUGH': return BodyRange_Style.STRIKETHROUGH;
      case 'MONOSPACE': return BodyRange_Style.MONOSPACE;
      default: return BodyRange_Style.NONE;
    }
  };
  const out: BodyRangeInit[] = (styles || []).map((st) => ({
    start: st.start,
    length: st.length,
    associatedValue: { case: 'style', value: mapStyle(st.style) },
  }));
  for (const m of mentions || []) {
    if (isAci(m.uuid)) out.push({ start: m.start, length: m.length, associatedValue: { case: 'mentionAci', value: m.uuid } });
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

function httpBinary(method: string, url: string, body?: Uint8Array | null, headers?: Record<string, string>, timeout?: number): Promise<Uint8Array> {
  return getApp().http.rawBinary(method, url, body, headers, timeout);
}

function httpRaw(method: string, url: string, body?: Uint8Array | null, headers?: Record<string, string>, timeout?: number) {
  return getApp().http.rawRequest(method, url, body, headers, timeout);
}

const client = new SignalClient(store, httpJson, httpBinary, httpRaw);

function serverUrl(): string {
  return getApp().config.serverUrl() || DEFAULT_SIGNAL_SERVER;
}

/** Signal addresses users by ACI; map a phone number to its ACI through the synced contact list. */
async function resolveAci(id: string): Promise<string> {
  if (isAci(id)) return id;
  const contacts: Array<any> = (await getApp().db.kvGet('syncedContacts')) || [];
  const hit = contacts.find((c) => c.number === id && isAci(c.uuid));
  return hit ? hit.uuid : '';
}

async function resolveRecipients(ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    const aci = await resolveAci(id);
    if (!aci) throw new Error('No Signal account known for ' + id);
    out.push(aci);
  }
  return out;
}

async function resolveGroupRecipients(groupSendId: string): Promise<{ internalId: string; members: string[]; masterKey?: string; revision?: number }> {
  const App = getApp();
  const internalId = groupSendId.replace(/^group\./, '');
  const syncedGroups: Array<any> = (await App.db.kvGet('syncedGroups')) || [];
  const found = syncedGroups.find((g) => g.id === groupSendId || g.internal_id === internalId);
  const selfAci = App.config.aci ? App.config.aci() : '';
  const members = ((found && found.members) || []).filter((m: string) => isAci(m) && m !== selfAci);
  return {
    internalId,
    members,
    masterKey: found ? found.masterKey : undefined,
    revision: found ? found.revision : undefined,
  };
}

async function groupTargets(recipient: string): Promise<{ isGroup: boolean; peers: string[]; groupV2?: DataMessage['groupV2']; internalId: string }> {
  if (!recipient.startsWith('group.')) {
    return { isGroup: false, peers: await resolveRecipients([recipient]), internalId: '' };
  }
  const grp = await resolveGroupRecipients(recipient);
  const groupV2 = buildGroupContextV2({ masterKey: grp.masterKey, revision: grp.revision });
  if (!groupV2) throw new Error('This group has no Groups V2 master key; legacy groups are not supported');
  return { isGroup: true, peers: grp.members, groupV2, internalId: grp.internalId };
}

async function deliver(target: { isGroup: boolean; peers: string[] }, content: Content, ts: number, online = false): Promise<void> {
  if (target.isGroup) {
    await client.sendGroupContent(target.peers, content, ts, online);
  } else {
    for (const peer of target.peers) await client.sendContentToRecipient(peer, content, ts, online);
  }
}

/**
 * Persist a sender's 32-byte ProfileKey onto `syncedContacts` and in-memory `SignalClient`.
 */
async function recordPeerProfileKey(senderUuid: string, senderE164: string | undefined, profileKeyBytes: Uint8Array): Promise<void> {
  if (profileKeyBytes.length !== 32 || !isAci(senderUuid)) return;
  client.setPeerProfileKey(senderUuid, profileKeyBytes);

  const App = getApp();
  const b64 = toBase64(profileKeyBytes);
  const list: Array<any> = (await App.db.kvGet('syncedContacts')) || [];
  let found = false;
  let changed = false;
  for (const c of list) {
    if (c.uuid === senderUuid || (senderE164 && c.number === senderE164)) {
      found = true;
      if (c.profileKey !== b64) {
        c.profileKey = b64;
        changed = true;
      }
    }
  }
  if (!found) {
    list.push({ uuid: senderUuid, number: senderE164 || '', name: senderE164 || senderUuid, blocked: false, expireTimer: 0, profileKey: b64 });
    changed = true;
  }
  if (changed) await App.db.kvSet('syncedContacts', list);
}

/** Fetch a group's current title, members, and settings from the storage server and merge them into `syncedGroups`. */
async function refreshGroup(masterKey: Uint8Array): Promise<void> {
  const App = getApp();
  const state = await fetchGroupState(store, httpJson, httpBinary, masterKey, serverUrl());
  const list: Array<any> = (await App.db.kvGet('syncedGroups')) || [];
  const idx = list.findIndex((g) => g.internal_id === state.internal_id);
  const prev = idx >= 0 ? list[idx] : {};
  const merged = { ...prev, ...state, blocked: prev.blocked ?? false, archived: prev.archived };
  if (idx >= 0) list[idx] = merged;
  else list.push(merged);
  await App.db.kvSet('syncedGroups', list);
  if (App.store && App.store.refreshDirectory) App.store.refreshDirectory().catch(() => {});
}

/** Record a group seen in an incoming message; fetch its state when it is new or its revision moved on. */
async function noteIncomingGroup(masterKey: Uint8Array, revision: number, sender: string, expireTimer: number): Promise<void> {
  const App = getApp();
  const keys = deriveGroupV2Keys(masterKey);
  const list: Array<any> = (await App.db.kvGet('syncedGroups')) || [];
  const existing = list.find((g) => g.internal_id === keys.internalId);
  const stale = !existing || (revision || 0) > (existing.revision || 0) || !(existing.members && existing.members.length);
  if (!existing) {
    list.push({
      id: keys.sendId,
      internal_id: keys.internalId,
      masterKey: toBase64(masterKey),
      revision: revision || 0,
      name: 'Group',
      members: [sender].filter(Boolean),
      admins: [],
      blocked: false,
      expireTimer,
    });
    await App.db.kvSet('syncedGroups', list);
  }
  if (stale) {
    refreshGroup(masterKey).catch((e: any) => App.util.dbg('group refresh failed: ' + (e && e.message)));
  }
}

/**
 * Pull contacts, Groups V2 master keys, and account settings from Signal's Storage Service.
 */
async function syncFromStorageService(): Promise<boolean> {
  const App = getApp();
  const res = await pullFromStorageService(store, httpJson, httpBinary, serverUrl());
  if (!res) return false;

  if (res.contacts.length > 0) {
    const existing: Array<any> = (await App.db.kvGet('syncedContacts')) || [];
    const byId = new Map<string, any>();
    for (const c of existing) byId.set(c.uuid || c.number, c);

    for (const sc of res.contacts) {
      const id = sc.aci || sc.e164;
      if (!id) continue;
      if (sc.aci && sc.profileKey) client.setPeerProfileKey(sc.aci, sc.profileKey);
      if (sc.aci && sc.identityKey) {
        await store.saveIdentity(sc.aci, sc.identityKey, { uuid: sc.aci, number: sc.e164 });
        if (sc.identityState) await store.setIdentityTrust(sc.aci, sc.identityState);
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
        profileKey: sc.profileKey ? toBase64(sc.profileKey) : prev.profileKey,
      });

      if (sc.archived !== undefined && App.store && App.store.setArchived) App.store.setArchived(id, sc.archived);
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
    for (const gv2 of res.groupsV2) {
      await refreshGroup(gv2.masterKey).catch((e: any) => App.util.dbg('group refresh failed: ' + (e && e.message)));
    }
  }

  if (res.account) {
    const patch: Record<string, any> = {};
    const fullName = [res.account.givenName, res.account.familyName].filter(Boolean).join(' ');
    if (fullName) patch.profileName = fullName;
    if (res.account.username) patch.username = res.account.username;
    if (res.account.readReceipts !== undefined) patch.sendReadReceipts = res.account.readReceipts;
    if (res.account.typingIndicators !== undefined) patch.typingIndicators = res.account.typingIndicators;
    if (Object.keys(patch).length > 0) App.config.set(patch);
  }

  if (App.store && App.store.refreshDirectory) await App.store.refreshDirectory().catch(() => {});
  return true;
}

async function handleIncomingSyncMessage(env: IncomingEnvelope, content: Content): Promise<void> {
  const App = getApp();
  if (content.content.case !== 'syncMessage') return;
  const acc = await store.getAccount();
  // Sync messages are only meaningful from our own devices
  if (!acc || env.sourceUuid !== acc.aci) return;
  const sm = content.content.value;
  const c = sm.content;

  switch (c.case) {
    case 'contacts': {
      if (!c.value.blob) break;
      try {
        const { bytes } = await client.downloadAttachment(c.value.blob);
        const parsed = parseContactsSyncBlob(bytes);
        const existing: Array<any> = (await App.db.kvGet('syncedContacts')) || [];
        const byId = new Map<string, any>();
        for (const e of existing) byId.set(e.uuid || e.number, e);
        for (const sc of parsed) {
          const id = sc.uuid || sc.number;
          const prev = byId.get(id) || {};
          byId.set(id, { ...prev, uuid: sc.uuid || prev.uuid || '', number: sc.number || prev.number || '', name: sc.name || prev.name, expireTimer: sc.expireTimer, blocked: prev.blocked ?? false });
        }
        await App.db.kvSet('syncedContacts', Array.from(byId.values()));
        if (App.store && App.store.refreshDirectory) App.store.refreshDirectory().catch(() => {});
      } catch (e: any) {
        App.util.dbg('sync contacts blob failed: ' + (e && e.message));
      }
      break;
    }
    case 'verified': {
      const v = c.value;
      const aci = v.destinationAci;
      if (!isAci(aci)) break;
      if (v.identityKey.length === 33) await store.saveIdentity(aci, v.identityKey, { uuid: aci });
      const level: TrustLevel =
        v.state === Verified_State.VERIFIED ? 'TRUSTED_VERIFIED' : v.state === Verified_State.UNVERIFIED ? 'UNTRUSTED' : 'TRUSTED_UNVERIFIED';
      await store.setIdentityTrust(aci, level);
      break;
    }
    case 'blocked': {
      const b = c.value;
      const blockedNums = new Set(b.numbers);
      const blockedAcis = new Set(b.acis);
      const blockedGrpIds = new Set(b.groupIds.map((g) => toBase64(g)));
      const contacts: Array<any> = (await App.db.kvGet('syncedContacts')) || [];
      for (const ct of contacts) ct.blocked = (ct.number && blockedNums.has(ct.number)) || (ct.uuid && blockedAcis.has(ct.uuid));
      await App.db.kvSet('syncedContacts', contacts);
      const groups: Array<any> = (await App.db.kvGet('syncedGroups')) || [];
      for (const g of groups) g.blocked = blockedGrpIds.has(g.internal_id);
      await App.db.kvSet('syncedGroups', groups);
      break;
    }
    case 'configuration': {
      const cfg = c.value;
      App.config.set({ sendReadReceipts: cfg.readReceipts, typingIndicators: cfg.typingIndicators });
      break;
    }
    case 'keys': {
      const k = c.value;
      let masterKey: Uint8Array | undefined;
      if (k.accountEntropyPool) {
        try {
          masterKey = libsignal.accountEntropyPoolDeriveMasterKey(k.accountEntropyPool);
        } catch {
          // fall back to the raw master key
        }
      }
      if (!masterKey && k.master.length === 32) masterKey = k.master;
      if (masterKey) {
        // SECURITY-REVIEW: master key and Account Entropy Pool are stored only in the on-device protocol store
        await store.saveAccount({ ...acc, masterKey, accountEntropyPool: k.accountEntropyPool || acc.accountEntropyPool });
        syncFromStorageService().catch(() => {});
      }
      break;
    }
    case 'fetchLatest':
      if (c.value.type === SyncMessage_FetchLatest_Type.STORAGE_MANIFEST) syncFromStorageService().catch(() => {});
      break;
    default:
      break;
  }
}

function syncSent(destination: string, ts: number, dm: DataMessageInit, editTimestamp?: number): Content {
  return create(ContentSchema, {
    content: {
      case: 'syncMessage',
      value: {
        content: {
          case: 'sent',
          value: {
            destinationServiceId: destination || undefined,
            timestamp: BigInt(ts),
            message: editTimestamp ? undefined : dm,
            editMessage: editTimestamp ? { targetSentTimestamp: BigInt(editTimestamp), dataMessage: dm } : undefined,
          },
        },
      },
    },
  });
}

function dataContent(dm: DataMessageInit): Content {
  return create(ContentSchema, { content: { case: 'dataMessage', value: dm } });
}

export const signalBridge = {
  store,
  client,

  /** Loads the libsignal WebAssembly module. Resolves to the pinned libsignal version; rejects with a `LibsignalUnavailableError` whose `reason` drives the failure screen. */
  ready(): Promise<string> {
    return loadLibsignal();
  },

  /** Start QR code provisioning for linking this KaiOS phone as a Signal secondary device. */
  startProvisioning(deviceName: string, callbacks: ProvisioningCallbacks): ProvisioningSession {
    const url = serverUrl();
    return startDeviceProvisioning(store, httpJson, deviceName, callbacks, { httpUrl: url, wsUrl: url.replace(/^http/, 'ws') });
  },

  /** Request contacts, blocked list, configuration, and keys from the primary device, and pull Storage Service. */
  async requestSync(): Promise<void> {
    await syncFromStorageService().catch(() => {});
    await client.requestInitialSync();
  },

  /** Rotate the signed and last-resort Kyber PreKeys and upload fresh one-time EC and Kyber PreKeys for both identities. */
  async replenishPreKeys(): Promise<void> {
    const acc = await store.getAccount();
    if (!acc) return;
    const basicAuth = { username: `${acc.aci}.${acc.deviceId}`, password: acc.password };
    await httpJson('PUT', '/v2/keys?identity=aci', await generatePreKeyUpload(store, 'aci', acc.aciIdentityKeyPair), { basicAuth });
    if (acc.pniIdentityKeyPair) {
      await httpJson('PUT', '/v2/keys?identity=pni', await generatePreKeyUpload(store, 'pni', acc.pniIdentityKeyPair), { basicAuth }).catch(() => {});
    }
  },

  /** Decode a binary WebSocket frame from `wss://chat.signal.org/v1/websocket/`. */
  decodeWsFrame(buf: ArrayBuffer | Uint8Array) {
    return decodeWebSocketMessage(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  },

  /** Encode a WebSocket response ACK for a processed request ID. */
  encodeWsAck(id: bigint, status = 200, message = 'OK'): Uint8Array {
    return encodeWebSocketResponse(id, status, message);
  },

  /** Encode a WebSocket keepalive request (`GET /v1/keepalive`). */
  encodeWsKeepalive(): Uint8Array {
    return encodeWebSocketRequest('GET', '/v1/keepalive', BigInt(Date.now()));
  },

  /**
   * Decrypt a binary Signal `Envelope` from a WebSocket `/api/v1/message` request and return the JSON frame ready for `App.store.ingestRaw`.
   */
  async processIncomingEnvelope(envelopeBytes: Uint8Array): Promise<{ envelope: any } | null> {
    const res = await client.enqueueDecryptEnvelope(envelopeBytes);
    if (!res) return null;
    const c = res.content.content;
    const sender = res.envelope.sourceUuid;

    if (c.case === 'dataMessage') {
      const dm = c.value;
      if (dm.profileKey.length === 32) recordPeerProfileKey(sender, res.envelope.sourceE164, dm.profileKey).catch(() => {});
      if (dm.groupV2 && dm.groupV2.masterKey.length === 32) {
        noteIncomingGroup(dm.groupV2.masterKey, dm.groupV2.revision, sender, dm.expireTimer).catch(() => {});
      }
    }

    if (c.case === 'callMessage' && c.value.offer && isAci(sender)) {
      const busy = create(ContentSchema, { content: { case: 'callMessage', value: { busy: { id: c.value.offer.id } } } });
      client.sendContentToRecipient(sender, busy, Date.now(), true).catch(() => {});
    }

    if (c.case === 'syncMessage') handleIncomingSyncMessage(res.envelope, res.content).catch(() => {});
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

    if (payload.text_mode === 'styled' && rawText && App.util && App.util.parseStyledMarkdown) {
      const parsed = App.util.parseStyledMarkdown(rawText);
      bodyText = parsed.body;
      styles = parsed.styles;
    }

    const firstTarget = (payload.recipients && payload.recipients[0]) || '';
    const target = await groupTargets(firstTarget);

    const uploadedAttachments: AttachmentPointer[] = [];
    for (const dataUri of payload.base64_attachments || []) {
      const { contentType, filename, bytes } = parseDataUri(dataUri);
      const ext = contentType.split('/')[1] || 'bin';
      const ptr = await client.uploadAttachment(bytes, contentType, filename || `attachment.${ext}`);
      if (contentType.startsWith('audio/')) ptr.flags |= AttachmentPointer_Flags.VOICE_MESSAGE;
      uploadedAttachments.push(ptr);
    }

    const convId = target.isGroup ? 'g:' + target.internalId : firstTarget;
    const expireTimer = App.store && App.store.convExpire ? App.store.convExpire(convId) : 0;

    const acc = await store.getAccount();
    const dm: DataMessageInit = {
      body: bodyText,
      timestamp: BigInt(ts),
      expireTimer: expireTimer || undefined,
      profileKey: acc ? acc.profileKey : undefined,
      attachments: uploadedAttachments,
      bodyRanges: stylesToBodyRanges(styles, payload.mentions),
      groupV2: target.groupV2,
    };

    if (payload.quote_timestamp) {
      const authorAci = await resolveAci(payload.quote_author || '');
      dm.quote = { id: BigInt(payload.quote_timestamp), authorAci: authorAci || undefined, text: payload.quote_message || '' };
    }

    const content = payload.edit_timestamp
      ? create(ContentSchema, {
          content: { case: 'editMessage', value: { targetSentTimestamp: BigInt(payload.edit_timestamp), dataMessage: dm } },
        })
      : dataContent(dm);

    await deliver(target, content, ts);
    await client.sendSyncMessage(syncSent(target.isGroup ? '' : target.peers[0], ts, dm, payload.edit_timestamp), ts);
    return { timestamp: ts };
  },

  async sendReaction(recipient: string, targetAuthor: string, targetTimestamp: number, emoji: string, remove: boolean): Promise<void> {
    const ts = Date.now();
    const target = await groupTargets(recipient);
    const targetAuthorAci = await resolveAci(targetAuthor);
    if (!targetAuthorAci) throw new Error('No Signal account known for ' + targetAuthor);
    const dm: DataMessageInit = {
      timestamp: BigInt(ts),
      groupV2: target.groupV2,
      reaction: { emoji, remove, targetAuthorAci, targetSentTimestamp: BigInt(targetTimestamp) },
    };
    await deliver(target, dataContent(dm), ts);
    await client.sendSyncMessage(syncSent(target.isGroup ? '' : target.peers[0], ts, dm), ts);
  },

  async sendRemoteDelete(recipient: string, targetTimestamp: number): Promise<void> {
    const ts = Date.now();
    const target = await groupTargets(recipient);
    const dm: DataMessageInit = {
      timestamp: BigInt(ts),
      groupV2: target.groupV2,
      delete: { targetSentTimestamp: BigInt(targetTimestamp) },
    };
    await deliver(target, dataContent(dm), ts);
    await client.sendSyncMessage(syncSent(target.isGroup ? '' : target.peers[0], ts, dm), ts);
  },

  async sendTyping(recipient: string, started: boolean): Promise<void> {
    const ts = Date.now();
    const target = await groupTargets(recipient);
    const content = create(ContentSchema, {
      content: {
        case: 'typingMessage',
        value: {
          timestamp: BigInt(ts),
          action: started ? TypingMessage_Action.STARTED : TypingMessage_Action.STOPPED,
          groupId: target.isGroup ? fromBase64(target.internalId) : undefined,
        },
      },
    });
    await deliver(target, content, ts, true);
  },

  async sendReadReceipt(recipient: string, timestamp: number): Promise<void> {
    const now = Date.now();
    const aci = await resolveAci(recipient);
    if (!aci) return;
    await client.sendContentToRecipient(
      aci,
      create(ContentSchema, { content: { case: 'receiptMessage', value: { type: ReceiptMessage_Type.READ, timestamp: [BigInt(timestamp)] } } }),
      now
    );
    await client.sendSyncMessage(
      create(ContentSchema, { content: { case: 'syncMessage', value: { read: [{ senderAci: aci, timestamp: BigInt(timestamp) }] } } }),
      now
    );
  },

  async downloadAttachmentBlob(id: string): Promise<Blob> {
    const { bytes, contentType } = await client.downloadAttachment(id);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Blob([ab], { type: contentType });
  },

  async fetchContactAvatarBlob(uuidOrNumber: string): Promise<Blob> {
    const App = getApp();
    const cached = await App.db.getAttachment('avatar:' + uuidOrNumber);
    if (cached && cached.blob) return cached.blob;

    const contacts: Array<any> = (await App.db.kvGet('syncedContacts')) || [];
    const entry = contacts.find((c) => c.uuid === uuidOrNumber || c.number === uuidOrNumber);
    const uuid = (entry && entry.uuid) || uuidOrNumber;
    if (!isAci(uuid)) throw new Error('No profile avatar available');
    const pkBytes = client.getPeerProfileKey(uuid) || (entry && entry.profileKey ? fromBase64(entry.profileKey) : undefined);

    const prof = await fetchAndDecryptProfile(store, httpJson, uuid, pkBytes, serverUrl());
    if (prof && prof.fullName && entry && (!entry.name || entry.name === uuid)) {
      entry.name = prof.fullName;
      await App.db.kvSet('syncedContacts', contacts);
    }
    if (!prof || !prof.avatarUrlPath || !pkBytes) throw new Error('No profile avatar available');

    const avatarBytes = await downloadAndDecryptProfileAvatar(httpBinary, prof.avatarUrlPath, pkBytes);
    const ab = avatarBytes.buffer.slice(avatarBytes.byteOffset, avatarBytes.byteOffset + avatarBytes.byteLength) as ArrayBuffer;
    const blob = new Blob([ab], { type: 'image/jpeg' });
    await App.db.putAttachment('avatar:' + uuidOrNumber, blob, 'image/jpeg');
    return blob;
  },

  async updateOwnProfile(body: { name?: string; about?: string }): Promise<void> {
    const App = getApp();
    await uploadOwnProfile(store, httpJson, { name: body.name || App.config.profileName() || 'Signal User', about: body.about }, serverUrl()).catch(() => {});
  },

  async lookupUsername(rawUsername: string): Promise<{ uuid: string; username: string } | null> {
    return resolveSignalUsername(store, httpJson, rawUsername, serverUrl());
  },

  async identities() {
    return client.listIdentitiesWithSafetyNumbers();
  },

  async trustIdentity(target: string, opts?: { verified_safety_number?: string; trust_all_known_keys?: boolean }): Promise<void> {
    const level: TrustLevel = opts?.verified_safety_number ? 'TRUSTED_VERIFIED' : 'TRUSTED_UNVERIFIED';
    const aci = (await resolveAci(target)) || target;
    await store.setIdentityTrust(aci, level);

    const idRec = await store.getIdentity(aci);
    if (idRec && isAci(aci)) {
      await client.sendSyncMessage(
        create(ContentSchema, {
          content: {
            case: 'syncMessage',
            value: {
              content: {
                case: 'verified',
                value: {
                  destinationAci: aci,
                  identityKey: idRec.publicKey,
                  state: level === 'TRUSTED_VERIFIED' ? Verified_State.VERIFIED : Verified_State.DEFAULT,
                },
              },
            },
          },
        })
      );
    }
  },

  verifySafetyNumberQr(scannedString: string, expectedScannableB64: string, expectedSafetyNumber: string): boolean {
    try {
      const cleanDigits = scannedString.replace(/\D/g, '');
      if (cleanDigits.length === 60 && cleanDigits === expectedSafetyNumber) return true;
      // QR scanners hand back either base64 or a binary latin1 string
      let scannedBytes: Uint8Array;
      try {
        scannedBytes = fromBase64(scannedString);
      } catch {
        scannedBytes = new Uint8Array(scannedString.length);
        for (let i = 0; i < scannedString.length; i++) scannedBytes[i] = scannedString.charCodeAt(i) & 0xff;
      }
      return compareScannedSafetyNumber(fromBase64(expectedScannableB64), scannedBytes);
    } catch {
      return false;
    }
  },
};

if (typeof window !== 'undefined') {
  const App = getApp();
  App.signal = signalBridge;
}
