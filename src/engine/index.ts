/* The on-device Signal engine's public surface (`signalBridge`), imported by the app in `src/ui/`. The app installs an `EngineHost` (`./host`) before calling it. */

import type { MessageInitShape } from '@bufbuild/protobuf';

import { bytesToUuid, constantTimeEqual, fromBase64, toBase64, uuidToBytes } from './bytes';
import {
  AddressableMessageSchema,
  AttachmentPointer,
  AttachmentPointer_Flags,
  BodyRange_Style,
  BodyRangeSchema,
  Content,
  ContentSchema,
  ConversationIdentifierSchema,
  DataMessage,
  DataMessage_Flags,
  DataMessageSchema,
  PreviewSchema,
  ReceiptMessage_Type,
  SyncMessage_FetchLatest_Type,
  SyncMessage_MessageRequestResponse_Type,
  TypingMessage_Action,
  Verified_State,
} from './gen/SignalService_pb';
import { buildGroupContextV2, deriveGroupV2Keys, fetchGroupState, GroupLinkMode, GroupV2Metadata, SERVER_PUBLIC_PARAMS } from './services/groups-v2';
import {
  addMembersActions,
  applyGroupChange,
  approveRequestsActions,
  descriptionActions,
  GroupActionsInit,
  GroupSnapshot,
  inviteLinkActions,
  leaveActions,
  permissionActions,
  removeMembersActions,
  roleActions,
  timerActions,
  titleActions,
} from './services/group-changes';
import { libsignal, loadLibsignal } from './protocol/libsignal';
import {
  downloadAndDecryptProfileAvatar,
  fetchAndDecryptProfile,
  fetchExpiringProfileKeyCredential,
  resolveSignalUsername,
  uploadOwnProfile,
} from './services/profiles';
import { generatePreKeyUpload } from './protocol/prekeys';
import { create, decodeWebSocketMessage, encodeWebSocketRequest, encodeWebSocketResponse, fromBinary, isAci, serviceIdFrom } from './net/proto';
import { compareScannedSafetyNumber } from './protocol/protocol';
import { decryptDeviceName, ProvisioningCallbacks, ProvisioningSession, startDeviceProvisioning } from './net/provisioning';
import { DeviceNameSchema } from './gen/DeviceName_pb';
import { IndexedDbSignalStore, TrustLevel } from './protocol/store';
import { POLL_QUESTION_MAX_SEND, validPoll } from './services/polls';
import { mutateStorage, pullFromStorageService, setPhoneNumberPrivacy, StorageMutation, StorageWriteQueue } from './services/storage-service';
import { AccountRecord_PinnedConversation, AccountRecord_PinnedConversationSchema, AccountRecord_UsernameLinkSchema, ContactRecord_NameSchema } from './gen/SignalStorage_pb';
import { diffGroupState, groupChangeAuthor, isDecodedGroup } from './services/group-updates';
import { reportSpam as reportSpamMessages } from './services/report-spam';
import { previewFieldsForSend } from './services/link-previews';
import { deleteUsername as deleteAccountUsername, setUsername as setAccountUsername, usernameLinkUrl } from './services/usernames';
import { SignalClient } from './net/client';
import { DEFAULT_SIGNAL_SERVER } from './net/http';
import { net } from './net/transport';
import { IncomingEnvelope, parseContactsSyncBlob } from './net/receive';
import { ChatStateEntry, host } from './host';

type DataMessageInit = MessageInitShape<typeof DataMessageSchema>;
type BodyRangeInit = MessageInitShape<typeof BodyRangeSchema>;
type PinnedConversationInit = MessageInitShape<typeof AccountRecord_PinnedConversationSchema>;
type AddressableMessageInit = MessageInitShape<typeof AddressableMessageSchema>;
type ConversationIdentifierInit = MessageInitShape<typeof ConversationIdentifierSchema>;
type PreviewInit = MessageInitShape<typeof PreviewSchema>;

/** A message as the app names it: its author (number or ACI) and sent time. */
export interface MessageRef {
  author: string;
  timestamp: number;
}

const MAX_DEVICE_NAME = 64;
/** Signal-Desktop's composer limit. */
const MAX_ATTACHMENTS = 32;

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

const MAX_PREVIEW_IMAGE_BYTES = 1024 * 1024;

async function outgoingPreview(
  p: { url: string; title: string; description?: string; date?: number; image?: string } | undefined,
  body: string,
  hasAttachments: boolean
): Promise<PreviewInit | null> {
  const fields = previewFieldsForSend(p, body, hasAttachments);
  if (!fields || !p) return null;
  const out: PreviewInit = { ...fields };
  if (p.image) {
    const { contentType, bytes } = parseDataUri(p.image);
    if (contentType.indexOf('image/') === 0 && bytes.length > 0 && bytes.length <= MAX_PREVIEW_IMAGE_BYTES) {
      out.image = await client.uploadAttachment(bytes, contentType, 'preview.' + (contentType.split('/')[1] || 'jpg'));
    }
  }
  return out;
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
  return host().http.request(method, path, body, {
    baseUrl: opts?.baseUrl || host().config.serverUrl() || DEFAULT_SIGNAL_SERVER,
    noAuth: opts?.noAuth,
    basicAuth: opts?.basicAuth,
    headers: opts?.headers,
    timeout: opts?.timeout,
  });
}

function httpBinary(method: string, url: string, body?: Uint8Array | null, headers?: Record<string, string>, timeout?: number): Promise<Uint8Array> {
  return host().http.rawBinary(method, url, body, headers, timeout);
}

function httpRaw(method: string, url: string, body?: Uint8Array | null, headers?: Record<string, string>, timeout?: number) {
  return host().http.rawRequest(method, url, body, headers, timeout);
}

const client = new SignalClient(store, httpJson, httpBinary, httpRaw);

function serverUrl(): string {
  return host().config.serverUrl() || DEFAULT_SIGNAL_SERVER;
}

function fetchLatestSync(type: SyncMessage_FetchLatest_Type): Content {
  return create(ContentSchema, { content: { case: 'syncMessage', value: { content: { case: 'fetchLatest', value: { type } } } } });
}

interface BlockedSets {
  acis: Set<string>;
  numbers: Set<string>;
  groups: Set<string>;
}

let blockedCache: Promise<BlockedSets> | null = null;

/** Blocked people and groups from `syncedContacts` / `syncedGroups`, cached until `invalidateBlocked()`. */
function blockedSets(): Promise<BlockedSets> {
  if (!blockedCache) {
    blockedCache = (async () => {
      const contacts: Array<any> = (await host().db.kvGet('syncedContacts')) || [];
      const groups: Array<any> = (await host().db.kvGet('syncedGroups')) || [];
      const out: BlockedSets = { acis: new Set(), numbers: new Set(), groups: new Set() };
      for (const c of contacts) {
        if (!c.blocked) continue;
        if (isAci(c.uuid)) out.acis.add(c.uuid);
        if (c.number) out.numbers.add(c.number);
      }
      for (const g of groups) if (g.blocked && g.internal_id) out.groups.add(g.internal_id);
      return out;
    })();
    blockedCache.catch(() => {
      blockedCache = null;
    });
  }
  return blockedCache;
}

function invalidateBlocked(): void {
  blockedCache = null;
}

function groupIdOf(mk: Uint8Array | undefined): string {
  if (!mk || mk.length !== 32) return '';
  try {
    return deriveGroupV2Keys(mk).internalId;
  } catch {
    return '';
  }
}

/** Whether an incoming message, edit, typing indicator, receipt, or call comes from a blocked person or a blocked group. */
async function isFromBlocked(env: IncomingEnvelope, content: Content): Promise<boolean> {
  const b = await blockedSets();
  if (b.acis.size === 0 && b.numbers.size === 0 && b.groups.size === 0) return false;
  if (env.sourceUuid && b.acis.has(env.sourceUuid)) return true;
  if (env.sourceE164 && b.numbers.has(env.sourceE164)) return true;
  const c = content.content;
  let groupId = '';
  if (c.case === 'dataMessage') groupId = groupIdOf(c.value.groupV2 && c.value.groupV2.masterKey);
  else if (c.case === 'editMessage') groupId = groupIdOf(c.value.dataMessage && c.value.dataMessage.groupV2 && c.value.dataMessage.groupV2.masterKey);
  else if (c.case === 'typingMessage' && c.value.groupId.length) groupId = toBase64(c.value.groupId);
  return !!groupId && b.groups.has(groupId);
}

async function isBlockedRecipient(recipient: string): Promise<boolean> {
  const b = await blockedSets();
  if (recipient.startsWith('group.')) return b.groups.has(recipient.replace(/^group\./, ''));
  return b.acis.has(recipient) || b.numbers.has(recipient);
}

/** The full blocked list for our other devices, as Signal-Desktop sends after every block or unblock. */
async function sendBlockedSync(): Promise<void> {
  const b = await blockedSets();
  await client.sendSyncMessage(
    create(ContentSchema, {
      content: {
        case: 'syncMessage',
        value: {
          content: {
            case: 'blocked',
            value: {
              acis: Array.from(b.acis),
              numbers: Array.from(b.numbers),
              groupIds: Array.from(b.groups).map((g) => fromBase64(g)),
            },
          },
        },
      },
    })
  );
}

/** A contact's ACI and phone number from either one, via `syncedContacts`. */
async function contactIds(id: string): Promise<{ aci: string; e164: string }> {
  const contacts: Array<any> = (await host().db.kvGet('syncedContacts')) || [];
  const hit = contacts.find((c) => (id && c.uuid === id) || (id && c.number === id));
  const aci = isAci(id) ? id : hit && isAci(hit.uuid) ? hit.uuid : '';
  const e164 = id.startsWith('+') ? id : (hit && hit.number) || '';
  return { aci, e164 };
}

/** Read-modify-write one `syncedContacts` entry (created when missing). */
async function updateSyncedContact(ids: { aci: string; e164: string }, update: (c: any) => void): Promise<void> {
  const list: Array<any> = (await host().db.kvGet('syncedContacts')) || [];
  let entry = list.find((c) => (ids.aci && c.uuid === ids.aci) || (ids.e164 && c.number === ids.e164));
  if (!entry) {
    entry = { uuid: ids.aci, number: ids.e164, name: ids.e164 || ids.aci, blocked: false, expireTimer: 0 };
    list.push(entry);
  }
  update(entry);
  await host().db.kvSet('syncedContacts', list);
}

/** Read-modify-write one `syncedGroups` entry. */
async function updateSyncedGroup(internalId: string, update: (g: any) => void): Promise<void> {
  const list: Array<any> = (await host().db.kvGet('syncedGroups')) || [];
  const entry = list.find((g) => g.internal_id === internalId);
  if (!entry) return;
  update(entry);
  await host().db.kvSet('syncedGroups', list);
}

/** Storage Service writes, batched; other devices are told to re-read the manifest after each one. */
const storageQueue = new StorageWriteQueue(
  (mutations) => mutateStorage(store, httpJson, httpBinary, serverUrl(), mutations),
  () => {
    client.sendSyncMessage(fetchLatestSync(SyncMessage_FetchLatest_Type.STORAGE_MANIFEST)).catch(() => {});
  }
);

/** Signal addresses users by ACI; map a phone number to its ACI through the synced contact list. */
async function resolveAci(id: string): Promise<string> {
  if (isAci(id)) return id;
  const contacts: Array<any> = (await host().db.kvGet('syncedContacts')) || [];
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
  const internalId = groupSendId.replace(/^group\./, '');
  const syncedGroups: Array<any> = (await host().db.kvGet('syncedGroups')) || [];
  const found = syncedGroups.find((g) => g.id === groupSendId || g.internal_id === internalId);
  const selfAci = host().config.aci();
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

/** A chat as sync messages name it, from its send ID: the group ID, else the person's ACI, else their number. */
async function conversationIdentifier(sendId: string): Promise<ConversationIdentifierInit | null> {
  if (sendId.startsWith('group.')) {
    const id = fromBase64(sendId.replace(/^group\./, ''));
    return id.length ? { identifier: { case: 'threadGroupId', value: id } } : null;
  }
  const ids = await contactIds(sendId);
  if (ids.aci) return { identifier: { case: 'threadServiceId', value: ids.aci } };
  if (ids.e164) return { identifier: { case: 'threadE164', value: ids.e164 } };
  return null;
}

async function addressableMessages(refs: MessageRef[]): Promise<AddressableMessageInit[]> {
  const acc = await store.getAccount();
  const out: AddressableMessageInit[] = [];
  for (const r of refs) {
    const mine = !!acc && (r.author === acc.number || r.author === acc.aci);
    const aci = mine ? acc!.aci : await resolveAci(r.author);
    const sentTimestamp = BigInt(r.timestamp);
    if (aci) out.push({ author: { case: 'authorServiceId', value: aci }, sentTimestamp });
    else if (r.author.startsWith('+')) out.push({ author: { case: 'authorE164', value: r.author }, sentTimestamp });
  }
  return out;
}

/** Resolves to whether every recipient got it sealed. */
async function deliver(target: { isGroup: boolean; peers: string[] }, content: Content, ts: number, online = false): Promise<boolean> {
  if (target.isGroup) return client.sendGroupContent(target.peers, content, ts, online);
  let sealed = target.peers.length > 0;
  for (const peer of target.peers) if (!(await client.sendContentToRecipient(peer, content, ts, online))) sealed = false;
  return sealed;
}

/**
 * Persist a sender's 32-byte ProfileKey onto `syncedContacts` and in-memory `SignalClient`.
 */
async function recordPeerProfileKey(senderUuid: string, senderE164: string | undefined, profileKeyBytes: Uint8Array): Promise<void> {
  if (profileKeyBytes.length !== 32 || !isAci(senderUuid)) return;
  client.setPeerProfileKey(senderUuid, profileKeyBytes);
  const b64 = toBase64(profileKeyBytes);
  const list: Array<any> = (await host().db.kvGet('syncedContacts')) || [];
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
  if (changed) await host().db.kvSet('syncedContacts', list);
}

/** Who made the change that brought a group to `revision`, and when it arrived. */
interface GroupChangeHint {
  author: string;
  revision: number;
  timestamp: number;
}

/** Save a group's new state, and tell the app what changed since the state we had; the change is attributed only when it's the very next revision. */
async function mergeGroupState(state: GroupV2Metadata, hint?: GroupChangeHint): Promise<void> {
  const list: Array<any> = (await host().db.kvGet('syncedGroups')) || [];
  const idx = list.findIndex((g) => g.internal_id === state.internal_id);
  const prev = idx >= 0 ? list[idx] : {};
  const merged = { ...prev, ...state, blocked: prev.blocked ?? false, archived: prev.archived };
  if (idx >= 0) list[idx] = merged;
  else list.push(merged);
  await host().db.kvSet('syncedGroups', list);
  host().directoryChanged().catch(() => {});
  if (!isDecodedGroup(prev) || state.revision <= (prev.revision || 0)) return;
  const author = hint && hint.revision === state.revision && (prev.revision || 0) + 1 === state.revision ? hint.author : '';
  const changes = diffGroupState(prev, state, author, host().config.aci() || '');
  if (changes.length) host().ingest({ envelope: { groupUpdate: { groupId: state.internal_id, author, timestamp: (hint && hint.timestamp) || Date.now(), changes } } });
}

/** Fetch a group's current title, members, and settings from the storage server and merge them into `syncedGroups`. */
async function refreshGroup(masterKey: Uint8Array, hint?: GroupChangeHint): Promise<void> {
  await mergeGroupState(await fetchGroupState(store, httpJson, httpBinary, masterKey, serverUrl()), hint);
}

async function groupMasterKey(groupSendId: string): Promise<Uint8Array> {
  const grp = await resolveGroupRecipients(groupSendId);
  const mk = grp.masterKey ? fromBase64(grp.masterKey) : new Uint8Array(0);
  if (mk.length !== 32) throw new Error('This group has no Groups V2 master key; legacy groups are not supported');
  return mk;
}

/**
 * Apply a Groups V2 change on the storage server, then send the signed change to everyone affected (GroupContextV2 with `groupChange`, as Signal-Desktop's sendGroupUpdate does) and to our other devices. Resolves to the new group state, or null when nothing changed.
 */
async function changeGroup(groupSendId: string, build: (snap: GroupSnapshot) => GroupActionsInit | null | Promise<GroupActionsInit | null>): Promise<GroupV2Metadata | null> {
  const masterKey = await groupMasterKey(groupSendId);
  const res = await applyGroupChange({ store, httpJson, httpBinary, serverUrl: serverUrl() }, masterKey, build);
  if (!res) return null;
  const acc = await store.getAccount();
  const ts = Date.now();
  await mergeGroupState(res.state, { author: acc ? acc.aci : '', revision: res.revision, timestamp: ts });
  const dm: DataMessageInit = {
    timestamp: BigInt(ts),
    profileKey: acc ? acc.profileKey : undefined,
    groupV2: { masterKey, revision: res.revision, groupChange: res.groupChange },
  };
  await client.sendGroupContent(res.notify, dataContent(dm), ts).catch((e: any) => host().dbg('group update send failed: ' + (e && e.message)));
  await client.sendSyncMessage(syncSent('', ts, dm), ts);
  return res.state;
}

/** Record a group seen in an incoming message; fetch its state when it is new or its revision moved on. */
async function noteIncomingGroup(masterKey: Uint8Array, revision: number, sender: string, expireTimer: number, groupChange: Uint8Array, timestamp: number): Promise<void> {
  const keys = deriveGroupV2Keys(masterKey);
  const list: Array<any> = (await host().db.kvGet('syncedGroups')) || [];
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
    await host().db.kvSet('syncedGroups', list);
  }
  if (stale) {
    const author = groupChangeAuthor(keys, groupChange, revision);
    const hint = author && author === sender ? { author, revision, timestamp } : undefined;
    refreshGroup(masterKey, hint).catch((e: any) => host().dbg('group refresh failed: ' + (e && e.message)));
  }
}

/**
 * Pull contacts, Groups V2 master keys, and account settings from Signal's Storage Service.
 */
async function syncFromStorageService(): Promise<boolean> {
  const res = await pullFromStorageService(store, httpJson, httpBinary, serverUrl());
  if (!res) return false;
  const chatState: ChatStateEntry[] = [];

  if (res.contacts.length > 0) {
    const existing: Array<any> = (await host().db.kvGet('syncedContacts')) || [];
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
        whitelisted: !!sc.whitelisted,
        systemContact: !!sc.systemContact,
        profileKey: sc.profileKey ? toBase64(sc.profileKey) : prev.profileKey,
      });

      if (sc.changed) chatState.push({ uuid: sc.aci || '', number: sc.e164 || '', archived: !!sc.archived, muted: (sc.mutedUntilTimestamp || 0) > Date.now(), markedUnread: !!sc.markedUnread });
    }
    await host().db.kvSet('syncedContacts', Array.from(byId.values()));
  }

  if (res.groupsV2.length > 0) {
    const existingGroups: Array<any> = (await host().db.kvGet('syncedGroups')) || [];
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
      if (gv2.changed) chatState.push({ groupInternalId: keys.internalId, archived: !!gv2.archived, muted: (gv2.mutedUntilTimestamp || 0) > Date.now(), markedUnread: !!gv2.markedUnread });
    }
    await host().db.kvSet('syncedGroups', Array.from(byGrpId.values()));
    for (const gv2 of res.groupsV2) {
      await refreshGroup(gv2.masterKey).catch((e: any) => host().dbg('group refresh failed: ' + (e && e.message)));
    }
  }

  if (res.account) {
    const patch: Record<string, any> = {};
    const fullName = [res.account.givenName, res.account.familyName].filter(Boolean).join(' ');
    if (fullName) patch.profileName = fullName;
    patch.username = res.account.username || '';
    const link = res.account.usernameLink;
    if (res.account.username && link) {
      patch.usernameLink = usernameLinkUrl(link.entropy, link.serverId);
      await store.storeValue('usernameLink', { entropy: toBase64(link.entropy), serverId: bytesToUuid(link.serverId) });
    } else {
      patch.usernameLink = '';
    }
    if (res.account.readReceipts !== undefined) patch.sendReadReceipts = res.account.readReceipts;
    if (res.account.typingIndicators !== undefined) patch.typingIndicators = res.account.typingIndicators;
    if (res.account.linkPreviews !== undefined) patch.linkPreviews = res.account.linkPreviews;
    if (res.account.sealedSenderIndicators !== undefined) patch.sealedSenderIndicators = res.account.sealedSenderIndicators;
    if (res.account.universalExpireTimer !== undefined) patch.defaultExpireTimer = res.account.universalExpireTimer;
    patch.sharePhoneNumber = res.account.sharePhoneNumber;
    patch.findableByNumber = res.account.findableByNumber;
    host().config.set(patch);
    const acc = await store.getAccount();
    if (acc && res.account.changed) chatState.push({ uuid: acc.aci, number: acc.number || '', archived: !!res.account.noteToSelfArchived, markedUnread: !!res.account.noteToSelfMarkedUnread });
  }

  invalidateBlocked();
  await host().directoryChanged().catch(() => {});
  const pinned = res.account && res.account.changed
    ? res.account.pinnedConversations.map((p) =>
        p.groupMasterKey ? { groupInternalId: deriveGroupV2Keys(p.groupMasterKey).internalId } : { uuid: p.aci || '', number: p.e164 || '' }
      )
    : null;
  host().applyChatState(chatState, pinned);
  return true;
}

/** Signal-Desktop `onDeviceNameChangeSync`: the phone renamed this device, so read the new name back from the server. */
async function refreshOwnDeviceName(): Promise<void> {
  const acc = await store.getAccount();
  if (!acc) return;
  // SECURITY-REVIEW: the device list is fetched with this device's credentials; the name is decrypted with our ACI identity key, which stays in the protocol store.
  const res = await httpJson('GET', '/v1/devices', null, { basicAuth: { username: `${acc.aci}.${acc.deviceId}`, password: acc.password } });
  const devices: any[] = res && Array.isArray(res.devices) ? res.devices : [];
  const ours = devices.find((d) => d && d.id === acc.deviceId);
  if (!ours || typeof ours.name !== 'string' || !ours.name) return;
  const name = (await decryptDeviceName(fromBinary(DeviceNameSchema, fromBase64(ours.name)), acc.aciIdentityKeyPair.privKey)).trim();
  if (name) host().config.set({ deviceName: name.slice(0, MAX_DEVICE_NAME) });
}

async function handleIncomingSyncMessage(env: IncomingEnvelope, content: Content): Promise<void> {
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
        const existing: Array<any> = (await host().db.kvGet('syncedContacts')) || [];
        const byId = new Map<string, any>();
        for (const e of existing) byId.set(e.uuid || e.number, e);
        for (const sc of parsed) {
          const id = sc.uuid || sc.number;
          const prev = byId.get(id) || {};
          byId.set(id, { ...prev, uuid: sc.uuid || prev.uuid || '', number: sc.number || prev.number || '', name: sc.name || prev.name, expireTimer: sc.expireTimer, blocked: prev.blocked ?? false });
        }
        await host().db.kvSet('syncedContacts', Array.from(byId.values()));
        host().directoryChanged().catch(() => {});
      } catch (e: any) {
        host().dbg('sync contacts blob failed: ' + (e && e.message));
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
      const contacts: Array<any> = (await host().db.kvGet('syncedContacts')) || [];
      for (const ct of contacts) ct.blocked = (ct.number && blockedNums.has(ct.number)) || (ct.uuid && blockedAcis.has(ct.uuid));
      await host().db.kvSet('syncedContacts', contacts);
      const groups: Array<any> = (await host().db.kvGet('syncedGroups')) || [];
      for (const g of groups) g.blocked = blockedGrpIds.has(g.internal_id);
      await host().db.kvSet('syncedGroups', groups);
      invalidateBlocked();
      break;
    }
    case 'messageRequestResponse': {
      const aci = serviceIdFrom(c.value.threadAci, c.value.threadAciBinary);
      if (c.value.type === SyncMessage_MessageRequestResponse_Type.ACCEPT && isAci(aci)) {
        await updateSyncedContact(await contactIds(aci), (ct) => {
          ct.whitelisted = true;
        });
      }
      break;
    }
    case 'configuration': {
      const cfg = c.value;
      host().config.set({
        sendReadReceipts: cfg.readReceipts,
        typingIndicators: cfg.typingIndicators,
        linkPreviews: cfg.linkPreviews,
        sealedSenderIndicators: cfg.unidentifiedDeliveryIndicators,
      });
      break;
    }
    case 'usernameChange':
      syncFromStorageService().catch(() => {});
      break;
    case 'deviceNameChange':
      if (c.value.deviceId === acc.deviceId) refreshOwnDeviceName().catch((e: any) => host().dbg('device name refresh failed: ' + (e && e.message)));
      break;
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
  net,

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
   * Decrypt a binary Signal `Envelope` from a WebSocket `/api/v1/message` request and return the JSON frame for the app's store.
   */
  async processIncomingEnvelope(envelopeBytes: Uint8Array): Promise<{ envelope: any } | null> {
    const res = await client.enqueueDecryptEnvelope(envelopeBytes);
    if (!res) return null;
    const c = res.content.content;
    const sender = res.envelope.sourceUuid;
    const acc = await store.getAccount();
    const fromSelf = !!acc && sender === acc.aci;

    if (c.case === 'syncMessage' && !fromSelf) return null;
    if (!fromSelf && (await isFromBlocked(res.envelope, res.content))) return null;

    if (c.case === 'dataMessage') {
      const dm = c.value;
      if (dm.profileKey.length === 32) recordPeerProfileKey(sender, res.envelope.sourceE164, dm.profileKey).catch(() => {});
      if (dm.groupV2 && dm.groupV2.masterKey.length === 32) {
        noteIncomingGroup(dm.groupV2.masterKey, dm.groupV2.revision, sender, dm.expireTimer, dm.groupV2.groupChange, res.envelope.timestamp).catch(() => {});
      } else if (dm.expireTimerVersion && isAci(sender)) {
        updateSyncedContact({ aci: sender, e164: res.envelope.sourceE164 || '' }, (ct) => {
          if (dm.expireTimerVersion >= (ct.expireTimerVersion || 0)) {
            ct.expireTimerVersion = dm.expireTimerVersion;
            ct.expireTimer = dm.expireTimer;
          }
        }).catch(() => {});
      }
    }

    if (c.case === 'callMessage' && c.value.offer && isAci(sender)) {
      const busy = create(ContentSchema, { content: { case: 'callMessage', value: { busy: { id: c.value.offer.id } } } });
      client.sendContentToRecipient(sender, busy, Date.now(), true).catch(() => {});
    }

    if (c.case === 'syncMessage') {
      const sent = c.value.content.case === 'sent' ? c.value.content.value.message : undefined;
      if (sent && sent.groupV2 && sent.groupV2.masterKey.length === 32) {
        noteIncomingGroup(sent.groupV2.masterKey, sent.groupV2.revision, sender, sent.expireTimer, sent.groupV2.groupChange, res.envelope.timestamp).catch(() => {});
      }
      handleIncomingSyncMessage(res.envelope, res.content).catch(() => {});
    }
    return res.normalizedFrame;
  },

  /**
   * Send an outgoing message, edit, or attachment. `message` is the plain body; `styles` are its formatting ranges.
   */
  async send(payload: {
    recipients: string[];
    message?: string;
    styles?: Array<{ start: number; length: number; style: string }>;
    expire_timer?: number;
    quote_timestamp?: number;
    quote_author?: string;
    quote_message?: string;
    quote_attachments?: Array<{ contentType: string; filename: string }>;
    base64_attachments?: string[];
    edit_timestamp?: number;
    mentions?: Array<{ start: number; length: number; uuid: string }>;
    view_once?: boolean;
    poll?: { question: string; options: string[]; allow_multiple: boolean };
    preview?: { url: string; title: string; description?: string; date?: number; image?: string };
  }): Promise<{ timestamp: number; sealed: boolean }> {
    const ts = Date.now();
    const bodyText = payload.message || '';
    const styles = payload.styles || [];

    const firstTarget = (payload.recipients && payload.recipients[0]) || '';
    const target = await groupTargets(firstTarget);
    const poll = payload.poll;
    if (poll && (!target.isGroup || !validPoll(poll.question, poll.options, POLL_QUESTION_MAX_SEND))) throw new Error('Polls need a group, a question, and 2 to 10 options');

    const files = payload.base64_attachments || [];
    if (files.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} attachments per message`);
    const uploadedAttachments: AttachmentPointer[] = [];
    for (const dataUri of files) {
      const { contentType, filename, bytes } = parseDataUri(dataUri);
      const ext = contentType.split('/')[1] || 'bin';
      const ptr = await client.uploadAttachment(bytes, contentType, filename || `attachment.${ext}`);
      if (contentType.startsWith('audio/') && files.length === 1) ptr.flags |= AttachmentPointer_Flags.VOICE_MESSAGE;
      uploadedAttachments.push(ptr);
    }

    const expireTimer = payload.expire_timer || 0;
    const preview = await outgoingPreview(payload.preview, bodyText, files.length > 0);

    const mentions: Array<{ start: number; length: number; uuid: string }> = [];
    for (const m of payload.mentions || []) {
      const aci = await resolveAci(m.uuid);
      if (aci) mentions.push({ start: m.start, length: m.length, uuid: aci });
    }

    const acc = await store.getAccount();
    const dm: DataMessageInit = {
      body: bodyText,
      timestamp: BigInt(ts),
      expireTimer: expireTimer || undefined,
      profileKey: acc ? acc.profileKey : undefined,
      attachments: uploadedAttachments,
      bodyRanges: stylesToBodyRanges(styles, mentions),
      groupV2: target.groupV2,
      isViewOnce: payload.view_once && uploadedAttachments.length > 0 ? true : undefined,
      pollCreate: poll ? { question: poll.question, options: poll.options, allowMultiple: poll.allow_multiple } : undefined,
      preview: preview ? [preview] : [],
    };

    if (payload.quote_timestamp) {
      const authorAci = await resolveAci(payload.quote_author || '');
      dm.quote = {
        id: BigInt(payload.quote_timestamp),
        authorAci: authorAci || undefined,
        text: payload.quote_message || '',
        attachments: (payload.quote_attachments || []).map((a) => ({ contentType: a.contentType || undefined, fileName: a.filename || undefined })),
      };
    }

    const content = payload.edit_timestamp
      ? create(ContentSchema, {
          content: { case: 'editMessage', value: { targetSentTimestamp: BigInt(payload.edit_timestamp), dataMessage: dm } },
        })
      : dataContent(dm);

    const sealed = await deliver(target, content, ts);
    await client.sendSyncMessage(syncSent(target.isGroup ? '' : target.peers[0], ts, dm, payload.edit_timestamp), ts);
    return { timestamp: ts, sealed };
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

  /** As a group admin, delete someone else's message for everyone (Signal-Desktop's AdminDelete). Members check that we are an admin. */
  async sendAdminDelete(groupSendId: string, targetAuthor: string, targetTimestamp: number): Promise<void> {
    const ts = Date.now();
    const target = await groupTargets(groupSendId);
    if (!target.isGroup) throw new Error('Admin delete only works in groups');
    const authorAci = await resolveAci(targetAuthor);
    if (!authorAci) throw new Error('No Signal account known for ' + targetAuthor);
    const dm: DataMessageInit = {
      timestamp: BigInt(ts),
      groupV2: target.groupV2,
      adminDelete: { targetAuthorAciBinary: uuidToBytes(authorAci), targetSentTimestamp: BigInt(targetTimestamp) },
    };
    await deliver(target, dataContent(dm), ts);
    await client.sendSyncMessage(syncSent('', ts, dm), ts);
  },

  /** Tell our other devices we deleted messages or whole chats here (Signal-Desktop's DeleteForMe sync). `chat` is the chat's send ID; a chat with no messages to name goes as a local-only delete. */
  async sendDeleteForMe(body: { messages?: Array<{ chat: string; items: MessageRef[] }>; chats?: Array<{ chat: string; mostRecent: MessageRef[]; mostRecentNonExpiring: MessageRef[] }> }): Promise<void> {
    const messageDeletes: Array<{ conversation: ConversationIdentifierInit; messages: AddressableMessageInit[] }> = [];
    for (const m of body.messages || []) {
      const conversation = await conversationIdentifier(m.chat);
      const messages = await addressableMessages(m.items);
      if (conversation && messages.length) messageDeletes.push({ conversation, messages });
    }
    const conversationDeletes: Array<{ conversation: ConversationIdentifierInit; mostRecentMessages: AddressableMessageInit[]; mostRecentNonExpiringMessages: AddressableMessageInit[]; isFullDelete: boolean }> = [];
    const localOnlyConversationDeletes: Array<{ conversation: ConversationIdentifierInit }> = [];
    for (const c of body.chats || []) {
      const conversation = await conversationIdentifier(c.chat);
      if (!conversation) continue;
      const mostRecentMessages = await addressableMessages(c.mostRecent);
      if (!mostRecentMessages.length) localOnlyConversationDeletes.push({ conversation });
      else conversationDeletes.push({ conversation, mostRecentMessages, mostRecentNonExpiringMessages: await addressableMessages(c.mostRecentNonExpiring), isFullDelete: true });
    }
    if (!messageDeletes.length && !conversationDeletes.length && !localOnlyConversationDeletes.length) return;
    await client.sendSyncMessage(
      create(ContentSchema, {
        content: { case: 'syncMessage', value: { content: { case: 'deleteForMe', value: { messageDeletes, conversationDeletes, localOnlyConversationDeletes } } } },
      })
    );
  },

  /** Pin a message for everyone in the chat (forever), or unpin it, as Signal-Desktop's PinMessage / UnpinMessage data messages. */
  async sendPin(recipient: string, targetAuthor: string, targetTimestamp: number, pin: boolean): Promise<void> {
    const ts = Date.now();
    const target = await groupTargets(recipient);
    const acc = await store.getAccount();
    const authorAci = acc && (targetAuthor === acc.number || targetAuthor === acc.aci) ? acc.aci : await resolveAci(targetAuthor);
    if (!authorAci) throw new Error('No Signal account known for ' + targetAuthor);
    const ref = { targetAuthorAciBinary: uuidToBytes(authorAci), targetSentTimestamp: BigInt(targetTimestamp) };
    const dm: DataMessageInit = {
      timestamp: BigInt(ts),
      groupV2: target.groupV2,
      pinMessage: pin ? { ...ref, pinDuration: { case: 'pinDurationForever', value: true } } : undefined,
      unpinMessage: pin ? undefined : ref,
    };
    await deliver(target, dataContent(dm), ts);
    await client.sendSyncMessage(syncSent(target.isGroup ? '' : target.peers[0], ts, dm), ts);
  },

  /** Vote in a group poll (Signal-Desktop's PollVote); `voteCount` rises with each of our votes so the newest one wins everywhere. No options clears our vote. */
  async sendPollVote(groupSendId: string, pollAuthor: string, pollTimestamp: number, optionIndexes: number[], voteCount: number): Promise<void> {
    const ts = Date.now();
    const target = await groupTargets(groupSendId);
    if (!target.isGroup) throw new Error('Polls only work in groups');
    const acc = await store.getAccount();
    const authorAci = acc && (pollAuthor === acc.number || pollAuthor === acc.aci) ? acc.aci : await resolveAci(pollAuthor);
    if (!authorAci) throw new Error('No Signal account known for ' + pollAuthor);
    const dm: DataMessageInit = {
      timestamp: BigInt(ts),
      groupV2: target.groupV2,
      pollVote: { targetAuthorAciBinary: uuidToBytes(authorAci), targetSentTimestamp: BigInt(pollTimestamp), optionIndexes, voteCount },
    };
    await deliver(target, dataContent(dm), ts);
    await client.sendSyncMessage(syncSent('', ts, dm), ts);
  },

  /** End our own group poll (Signal-Desktop's PollTerminate). Resolves to when it ended. */
  async sendPollTerminate(groupSendId: string, pollTimestamp: number): Promise<number> {
    const ts = Date.now();
    const target = await groupTargets(groupSendId);
    if (!target.isGroup) throw new Error('Polls only work in groups');
    const dm: DataMessageInit = {
      timestamp: BigInt(ts),
      groupV2: target.groupV2,
      pollTerminate: { targetSentTimestamp: BigInt(pollTimestamp) },
    };
    await deliver(target, dataContent(dm), ts);
    await client.sendSyncMessage(syncSent('', ts, dm), ts);
    return ts;
  },

  async sendTyping(recipient: string, started: boolean): Promise<void> {
    if (await isBlockedRecipient(recipient)) return;
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
    if (!aci || (await isBlockedRecipient(aci)) || (await isBlockedRecipient(recipient))) return;
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

  /** We opened a voice message, video, or view-once media: a VIEWED receipt to the sender when `receipt` is set, and a Viewed sync (plus ViewOnceOpen for view-once) to our other devices, as Signal-Desktop does. */
  async sendViewed(recipient: string, timestamp: number, opts: { receipt: boolean; viewOnce: boolean }): Promise<void> {
    const now = Date.now();
    const aci = await resolveAci(recipient);
    if (!aci) return;
    if (opts.receipt && !(await isBlockedRecipient(aci)) && !(await isBlockedRecipient(recipient))) {
      await client.sendContentToRecipient(
        aci,
        create(ContentSchema, { content: { case: 'receiptMessage', value: { type: ReceiptMessage_Type.VIEWED, timestamp: [BigInt(timestamp)] } } }),
        now
      );
    }
    const ref = { senderAci: aci, timestamp: BigInt(timestamp) };
    await client.sendSyncMessage(
      create(ContentSchema, {
        content: {
          case: 'syncMessage',
          value: { viewed: [ref], content: opts.viewOnce ? { case: 'viewOnceOpen', value: ref } : { case: undefined } },
        },
      }),
      now
    );
  },

  async downloadAttachmentBlob(id: string): Promise<Blob> {
    const { bytes, contentType } = await client.downloadAttachment(id);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Blob([ab], { type: contentType });
  },

  async fetchContactAvatarBlob(uuidOrNumber: string): Promise<Blob> {
    const cached = await host().db.getAttachment('avatar:' + uuidOrNumber);
    if (cached && cached.blob) return cached.blob;

    const contacts: Array<any> = (await host().db.kvGet('syncedContacts')) || [];
    const entry = contacts.find((c) => c.uuid === uuidOrNumber || c.number === uuidOrNumber);
    const uuid = (entry && entry.uuid) || uuidOrNumber;
    if (!isAci(uuid)) throw new Error('No profile avatar available');
    const pkBytes = client.getPeerProfileKey(uuid) || (entry && entry.profileKey ? fromBase64(entry.profileKey) : undefined);

    const prof = await fetchAndDecryptProfile(store, httpJson, uuid, pkBytes, serverUrl());
    if (prof && prof.fullName && entry && (!entry.name || entry.name === uuid)) {
      entry.name = prof.fullName;
      await host().db.kvSet('syncedContacts', contacts);
    }
    if (!prof || !prof.avatarUrlPath || !pkBytes) throw new Error('No profile avatar available');

    const avatarBytes = await downloadAndDecryptProfileAvatar(httpBinary, prof.avatarUrlPath, pkBytes);
    const ab = avatarBytes.buffer.slice(avatarBytes.byteOffset, avatarBytes.byteOffset + avatarBytes.byteLength) as ArrayBuffer;
    const blob = new Blob([ab], { type: 'image/jpeg' });
    await host().db.putAttachment('avatar:' + uuidOrNumber, blob, 'image/jpeg');
    return blob;
  },

  async updateOwnProfile(body: { name?: string; about?: string; emoji?: string }): Promise<void> {
    await uploadOwnProfile(
      store,
      httpJson,
      { name: body.name || host().config.profileName() || 'Signal User', about: body.about, emoji: body.emoji, sharePhoneNumber: host().config.sharePhoneNumber() },
      serverUrl()
    ).catch(() => {});
  },

  /** Who sees our number (`AccountRecord.phoneNumberSharingMode`, and the profile's sharing flag) and who can find us by it (`unlistedPhoneNumber`), shared with our other devices. */
  async setPhoneNumberPrivacy(share: boolean, findable: boolean): Promise<void> {
    await storageQueue.enqueue([{ type: 'account', update: (a) => setPhoneNumberPrivacy(a, share, findable) }]);
    host().config.set({ sharePhoneNumber: share, findableByNumber: share || findable });
    await uploadOwnProfile(store, httpJson, { name: host().config.profileName(), sharePhoneNumber: share }, serverUrl());
  },

  /** Set or clear a contact's nickname (Storage Service `ContactRecord.nickname`, shown on all your devices). */
  async setContactNickname(id: string, name: string): Promise<void> {
    const ids = await contactIds(id);
    if (!ids.aci && !ids.e164) throw new Error('No Signal account known for ' + id);
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    const given = parts[0] || '';
    const family = parts.slice(1).join(' ');
    await storageQueue.enqueue([
      {
        type: 'contact',
        aci: ids.aci || undefined,
        e164: ids.e164 || undefined,
        update: (c) => {
          c.nickname = given || family ? create(ContactRecord_NameSchema, { given, family }) : undefined;
        },
      },
    ]);
  },

  /** Block or unblock a person like Signal-Desktop: Blocked sync to our devices, then `ContactRecord.blocked` (and profile sharing off while blocked) in Storage Service. */
  async setContactBlocked(id: string, blocked: boolean): Promise<void> {
    const ids = await contactIds(id);
    if (!ids.aci && !ids.e164) throw new Error('No Signal account known for ' + id);
    await updateSyncedContact(ids, (c) => {
      c.blocked = blocked;
    });
    invalidateBlocked();
    host().directoryChanged().catch(() => {});
    await sendBlockedSync();
    await storageQueue.enqueue([
      {
        type: 'contact',
        aci: ids.aci || undefined,
        e164: ids.e164 || undefined,
        update: (c) => {
          c.blocked = blocked;
          c.blockedAtTimestamp = blocked ? BigInt(Date.now()) : 0n;
          c.whitelisted = !blocked;
        },
      },
    ]);
  },

  /** Answer a 1:1 message request on our other devices. Accepting also shares our profile with them, in Storage Service and with a PROFILE_KEY_UPDATE message, as Signal-Desktop does. */
  async sendMessageRequestResponse(sendId: string, response: 'accept' | 'delete' | 'block' | 'blockAndSpam'): Promise<void> {
    const ids = await contactIds(sendId);
    if (!ids.aci) throw new Error('No Signal account known for ' + sendId);
    const type = {
      accept: SyncMessage_MessageRequestResponse_Type.ACCEPT,
      delete: SyncMessage_MessageRequestResponse_Type.DELETE,
      block: SyncMessage_MessageRequestResponse_Type.BLOCK,
      blockAndSpam: SyncMessage_MessageRequestResponse_Type.BLOCK_AND_SPAM,
    }[response];
    await client.sendSyncMessage(create(ContentSchema, { content: { case: 'syncMessage', value: { content: { case: 'messageRequestResponse', value: { threadAci: ids.aci, type } } } } }));
    if (response !== 'accept') return;
    await updateSyncedContact(ids, (c) => {
      c.whitelisted = true;
    });
    await storageQueue.enqueue([
      {
        type: 'contact',
        aci: ids.aci,
        e164: ids.e164 || undefined,
        update: (c) => {
          c.whitelisted = true;
        },
      },
    ]);
    const acc = await store.getAccount();
    if (!acc || !acc.profileKey || acc.profileKey.length !== 32) return;
    const ts = Date.now();
    await client.sendContentToRecipient(ids.aci, dataContent({ timestamp: BigInt(ts), flags: DataMessage_Flags.PROFILE_KEY_UPDATE, profileKey: acc.profileKey }), ts);
  },

  /** Report someone's messages (by server GUID) as spam to Signal, as Signal-Desktop's reportSpamJobQueue does; returns how many were reported. */
  async reportSpam(sendId: string, serverGuids: string[], token?: string): Promise<number> {
    const ids = await contactIds(sendId);
    if (!ids.aci) throw new Error('No Signal account known for ' + sendId);
    return reportSpamMessages(store, httpJson, ids.aci, serverGuids, token, serverUrl());
  },

  /** Change a 1:1 chat's disappearing-message timer with an explicit EXPIRATION_TIMER_UPDATE message and a newer `expireTimerVersion`, as Signal-Desktop does. */
  async setDirectExpireTimer(recipient: string, seconds: number): Promise<void> {
    const ts = Date.now();
    const target = await groupTargets(recipient);
    if (target.isGroup) throw new Error('Use the group settings to change a group timer');
    const ids = await contactIds(target.peers[0]);
    let version = 1;
    await updateSyncedContact({ aci: target.peers[0], e164: ids.e164 }, (c) => {
      version = (c.expireTimerVersion || 1) + 1;
      c.expireTimerVersion = version;
      c.expireTimer = seconds;
    });
    const acc = await store.getAccount();
    const dm: DataMessageInit = {
      timestamp: BigInt(ts),
      flags: DataMessage_Flags.EXPIRATION_TIMER_UPDATE,
      expireTimer: Math.max(0, Math.floor(seconds)),
      expireTimerVersion: version,
      profileKey: acc ? acc.profileKey : undefined,
    };
    await deliver(target, dataContent(dm), ts);
    await client.sendSyncMessage(syncSent(target.peers[0], ts, dm), ts);
  },

  /** Change a group's name, description, disappearing-message timer, permissions, or group link on the storage server and notify its members. */
  async updateGroup(
    groupSendId: string,
    body: {
      name?: string;
      description?: string;
      expiration_time?: number;
      permissions?: { add_members?: 'every-member' | 'only-admins'; edit_group?: 'every-member' | 'only-admins'; send_messages?: 'every-member' | 'only-admins' };
      group_link?: GroupLinkMode;
      reset_link?: boolean;
    }
  ): Promise<GroupV2Metadata | null> {
    return changeGroup(groupSendId, (snap) => {
      const parts: Array<GroupActionsInit | null> = [];
      if (body.name != null) parts.push(titleActions(snap, body.name));
      if (body.description != null) parts.push(descriptionActions(snap, body.description));
      if (body.expiration_time != null) parts.push(timerActions(snap, body.expiration_time));
      if (body.permissions) parts.push(permissionActions(snap, body.permissions));
      if (body.group_link) parts.push(inviteLinkActions(snap, body.group_link, !!body.reset_link));
      const merged: GroupActionsInit = Object.assign({}, ...parts.filter(Boolean));
      return Object.keys(merged).length ? merged : null;
    });
  },

  /** Add people (numbers, usernames, or ACIs) to a group. Anyone whose profile key credential we can get joins directly; everyone else is invited. */
  async addGroupMembers(groupSendId: string, ids: string[]): Promise<GroupV2Metadata | null> {
    const acis: string[] = [];
    for (const raw of ids) {
      const id = String(raw || '').trim();
      let aci = await resolveAci(id);
      if (!aci && !id.startsWith('+')) {
        const hit = await resolveSignalUsername(store, httpJson, id, serverUrl());
        aci = hit ? hit.uuid : '';
      }
      if (!aci) throw new Error('No Signal account known for ' + id);
      acis.push(aci);
    }
    const credentials = new Map<string, Uint8Array>();
    const contacts: Array<any> = (await host().db.kvGet('syncedContacts')) || [];
    for (const aci of acis) {
      const entry = contacts.find((c) => c.uuid === aci);
      const pk = client.getPeerProfileKey(aci) || (entry && entry.profileKey ? fromBase64(entry.profileKey) : undefined);
      if (!pk || pk.length !== 32) continue;
      try {
        credentials.set(aci, await fetchExpiringProfileKeyCredential(store, httpJson, SERVER_PUBLIC_PARAMS, aci, pk, serverUrl()));
      } catch (e: any) {
        host().dbg('profile key credential failed; inviting instead: ' + (e && e.message));
      }
    }
    return changeGroup(groupSendId, (snap) =>
      addMembersActions(
        snap,
        acis.map((aci) => {
          const cred = credentials.get(aci);
          return { aci, presentation: cred ? libsignal.groupProfileKeyCredentialPresentation(SERVER_PUBLIC_PARAMS, snap.keys.secretParams, cred) : undefined };
        })
      )
    );
  },

  async removeGroupMembers(groupSendId: string, ids: string[]): Promise<GroupV2Metadata | null> {
    const resolved = await Promise.all(ids.map(async (id) => (await resolveAci(id)) || id));
    return changeGroup(groupSendId, (snap) => removeMembersActions(snap, resolved));
  },

  /** Let people who asked to join through the group link in; deny a request with `removeGroupMembers`. */
  async approveGroupRequests(groupSendId: string, ids: string[]): Promise<GroupV2Metadata | null> {
    return changeGroup(groupSendId, (snap) => approveRequestsActions(snap, ids));
  },

  async setGroupAdmins(groupSendId: string, ids: string[], admin: boolean): Promise<GroupV2Metadata | null> {
    const resolved = await Promise.all(ids.map(async (id) => (await resolveAci(id)) || id));
    return changeGroup(groupSendId, (snap) => roleActions(snap, resolved, admin));
  },

  /** Leave a group, decline its invite, or cancel a join request. */
  async leaveGroup(groupSendId: string): Promise<void> {
    await changeGroup(groupSendId, (snap) => leaveActions(snap));
  },

  /** Publish a chat's archive, mute, marked-unread, or pinned state to Storage Service so the account's other devices match. Only the fields that are set change. */
  async syncChatState(chat: { type: 'direct' | 'group'; sendId: string; archived?: boolean; muted?: boolean; markedUnread?: boolean; pinned?: boolean }): Promise<void> {
    const mutations: StorageMutation[] = [];
    const setState = (r: { archived: boolean; mutedUntilTimestamp: bigint; markedUnread: boolean }) => {
      if (chat.archived !== undefined) r.archived = chat.archived;
      if (chat.muted !== undefined) r.mutedUntilTimestamp = chat.muted ? BigInt(Number.MAX_SAFE_INTEGER) : 0n;
      if (chat.markedUnread !== undefined) r.markedUnread = chat.markedUnread;
    };
    const stateChanged = chat.archived !== undefined || chat.muted !== undefined || chat.markedUnread !== undefined;
    let isPin: (p: AccountRecord_PinnedConversation) => boolean;
    let pin: PinnedConversationInit;

    if (chat.type === 'group') {
      const masterKey = await groupMasterKey(chat.sendId);
      if (stateChanged) mutations.push({ type: 'groupV2', masterKey, update: setState });
      isPin = (p) => p.identifier.case === 'groupMasterKey' && constantTimeEqual(p.identifier.value, masterKey);
      pin = { identifier: { case: 'groupMasterKey', value: masterKey } };
    } else {
      const acc = await store.getAccount();
      const ids = await contactIds(chat.sendId);
      if (!ids.aci && !ids.e164) throw new Error('No Signal account known for ' + chat.sendId);
      const self = !!acc && (ids.aci === acc.aci || (!!ids.e164 && ids.e164 === acc.number));
      if (self && (chat.archived !== undefined || chat.markedUnread !== undefined)) {
        mutations.push({
          type: 'account',
          update: (a) => {
            if (chat.archived !== undefined) a.noteToSelfArchived = chat.archived;
            if (chat.markedUnread !== undefined) a.noteToSelfMarkedUnread = chat.markedUnread;
          },
        });
      } else if (!self && stateChanged) {
        mutations.push({ type: 'contact', aci: ids.aci || undefined, e164: ids.e164 || undefined, update: setState });
      }
      isPin = (p) => {
        if (p.identifier.case !== 'contact') return false;
        const c = p.identifier.value;
        const aci = serviceIdFrom(c.serviceId, c.serviceIdBinary);
        return (!!ids.aci && aci === ids.aci) || (!!ids.e164 && c.e164 === ids.e164);
      };
      pin = { identifier: { case: 'contact', value: { serviceId: ids.aci, serviceIdBinary: ids.aci ? uuidToBytes(ids.aci) : undefined, e164: ids.e164 } } };
    }

    if (chat.pinned !== undefined) {
      mutations.push({
        type: 'account',
        update: (a) => {
          const rest = a.pinnedConversations.filter((p) => !isPin(p));
          if (chat.pinned) rest.push(create(AccountRecord_PinnedConversationSchema, pin));
          a.pinnedConversations = rest;
        },
      });
    }
    await storageQueue.enqueue(mutations);
  },

  /** The disappearing-message timer new 1:1 chats start with (`AccountRecord.universalExpireTimer`), shared with our other devices. */
  async setUniversalExpireTimer(seconds: number): Promise<void> {
    const secs = Math.max(0, Math.floor(seconds) || 0);
    await storageQueue.enqueue([
      {
        type: 'account',
        update: (a) => {
          a.universalExpireTimer = secs;
        },
      },
    ]);
  },

  /** Whether links we send get previews (`AccountRecord.linkPreviews`), shared with our other devices. */
  async setLinkPreviews(on: boolean): Promise<void> {
    await storageQueue.enqueue([
      {
        type: 'account',
        update: (a) => {
          a.linkPreviews = on;
        },
      },
    ]);
  },

  /** Whether messages show when they were delivered privately (`AccountRecord.sealedSenderIndicators`), shared with our other devices. */
  async setSealedSenderIndicators(on: boolean): Promise<void> {
    await storageQueue.enqueue([
      {
        type: 'account',
        update: (a) => {
          a.sealedSenderIndicators = on;
        },
      },
    ]);
  },

  /** Block a group like Signal-Desktop's "Block and leave": leave it if we're still in it, then `GroupV2Record.blocked` in Storage Service and the Blocked sync. Unblocking only clears the block. */
  async setGroupBlocked(groupSendId: string, blocked: boolean): Promise<void> {
    const masterKey = await groupMasterKey(groupSendId);
    if (blocked) {
      try {
        await changeGroup(groupSendId, (snap) => leaveActions(snap));
      } catch (e: any) {
        if (!e || (e.name !== 'NotAMember' && e.status !== 403)) throw e;
      }
    }
    await updateSyncedGroup(deriveGroupV2Keys(masterKey).internalId, (g) => {
      g.blocked = blocked;
    });
    invalidateBlocked();
    host().directoryChanged().catch(() => {});
    await sendBlockedSync();
    await storageQueue.enqueue([
      {
        type: 'groupV2',
        masterKey,
        update: (g) => {
          g.blocked = blocked;
          g.blockedAtTimestamp = blocked ? BigInt(Date.now()) : 0n;
          g.whitelisted = !blocked;
        },
      },
    ]);
  },

  /** Reserve and confirm a Signal username (`nickname` gets a random number, `nickname.42` is taken as typed), then publish it and its link to Storage Service. */
  async setUsername(input: string): Promise<{ username: string; username_link: string }> {
    const previous = (await store.loadValue('usernameLink')) as { entropy: string; serverId: string } | undefined;
    const res = await setAccountUsername(store, httpJson, input, serverUrl(), previous ? fromBase64(previous.entropy) : undefined);
    const serverId = uuidToBytes(res.serverId);
    const link = usernameLinkUrl(res.entropy, serverId);
    await store.storeValue('usernameLink', { entropy: toBase64(res.entropy), serverId: res.serverId });
    host().config.set({ username: res.username, usernameLink: link });
    await storageQueue.enqueue([
      {
        type: 'account',
        update: (a) => {
          a.username = res.username;
          a.usernameLink = create(AccountRecord_UsernameLinkSchema, {
            entropy: res.entropy,
            serverId,
            color: a.usernameLink ? a.usernameLink.color : 0,
          });
        },
      },
    ]);
    return { username: res.username, username_link: link };
  },

  async deleteUsername(): Promise<void> {
    await deleteAccountUsername(store, httpJson, serverUrl());
    await store.storeValue('usernameLink', undefined);
    host().config.set({ username: '', usernameLink: '' });
    await storageQueue.enqueue([
      {
        type: 'account',
        update: (a) => {
          a.username = '';
          a.usernameLink = undefined;
        },
      },
    ]);
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

  /** Account facts and the server's count of unused one-time PreKeys, for Settings > Debug. Never includes keys or passwords. */
  async diagnostics(): Promise<{
    aci: string;
    pni: string;
    number: string;
    deviceId: number;
    registrationId: number;
    pniRegistrationId: number;
    preKeys: { ec: number; kyber: number } | null;
  }> {
    const acc = await store.getAccount();
    let preKeys: { ec: number; kyber: number } | null = null;
    if (acc) {
      try {
        const res = await httpJson('GET', '/v2/keys?identity=aci', null, { basicAuth: { username: `${acc.aci}.${acc.deviceId}`, password: acc.password } });
        preKeys = { ec: Number(res && res.count) || 0, kyber: Number(res && res.pqCount) || 0 };
      } catch (e: any) {
        host().dbg('PreKey count failed: ' + (e && e.message));
      }
    }
    return {
      aci: acc ? acc.aci : '',
      pni: (acc && acc.pni) || '',
      number: (acc && acc.number) || '',
      deviceId: acc ? acc.deviceId : 0,
      registrationId: acc ? acc.registrationId : 0,
      pniRegistrationId: acc ? acc.pniRegistrationId : 0,
      preKeys,
    };
  },
};

export type SignalBridge = typeof signalBridge;
