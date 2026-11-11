/* Reading the Storage Service: credentials, the encrypted manifest, and the contact, Groups V2, and account records we use, read the way Signal-Desktop's services/storage.preload.ts does. */

import { toBase64 } from '../../bytes';
import {
  AccountRecord_PhoneNumberSharingMode,
  ContactRecord_IdentityState,
  type ManifestRecord,
  ManifestRecord_Identifier_Type,
  ManifestRecordSchema,
  OptionalBool,
  ReadOperationSchema,
  StorageItemsSchema,
  StorageManifestSchema,
  type StorageRecord,
  StorageRecordSchema,
} from '../../gen/SignalStorage_pb';
import { accountBasicAuth, asObject, DEFAULT_STORAGE_SERVER, SignalHttpBinaryFn, SignalHttpJsonFn } from '../../net/http';
import { create, fromBinary, num, serviceIdFrom, toBinary } from '../../net/proto';
import type { SignalProtocolStore, TrustLevel } from '../../protocol/store';
import { decryptStorageValue, deriveStorageItemKey, deriveStorageManifestKey, deriveStorageServiceKey } from './crypto';

const READ_BATCH = 1024;
const STATE_KEY = 'storageServiceRecords';
/** Keys of records read from the server (written by another device) that no pull has reported yet. A write also reads new records, so this outlives one call. Unset until the first pull. */
const UNREPORTED_KEY = 'storageServiceUnreported';

interface StorageContactRecord {
  /** Another device wrote this record since the last pull. Chat-list state (archive, mute, pins) is only applied from changed records, so a local change made since then isn't undone. */
  changed: boolean;
  aci?: string;
  e164?: string;
  pni?: string;
  profileKey?: Uint8Array;
  identityKey?: Uint8Array;
  identityState?: TrustLevel;
  givenName?: string;
  familyName?: string;
  username?: string;
  blocked?: boolean;
  /** We share our profile with them: their chat is accepted rather than a message request. */
  whitelisted?: boolean;
  /** In the primary phone's address book. */
  systemContact?: boolean;
  archived?: boolean;
  markedUnread?: boolean;
  mutedUntilTimestamp?: number;
  nicknameGivenName?: string;
  nicknameFamilyName?: string;
}

interface StorageGroupV2Record {
  changed: boolean;
  masterKey: Uint8Array;
  blocked?: boolean;
  whitelisted?: boolean;
  archived?: boolean;
  markedUnread?: boolean;
  mutedUntilTimestamp?: number;
  /** Whether a mention still notifies while the group is muted; unset follows the account's default. */
  notifyForMentionsIfMuted?: boolean;
}

interface StoragePinnedConversation {
  aci?: string;
  e164?: string;
  groupMasterKey?: Uint8Array;
}

interface StorageAccountRecord {
  changed: boolean;
  profileKey?: Uint8Array;
  givenName?: string;
  familyName?: string;
  avatarUrlPath?: string;
  readReceipts?: boolean;
  typingIndicators?: boolean;
  linkPreviews?: boolean;
  sealedSenderIndicators?: boolean;
  /** Disappearing-message timer for new 1:1 chats, in seconds; 0 is off. */
  universalExpireTimer?: number;
  username?: string;
  usernameLink?: { entropy: Uint8Array; serverId: Uint8Array };
  pinnedConversations: StoragePinnedConversation[];
  noteToSelfArchived?: boolean;
  noteToSelfMarkedUnread?: boolean;
  /** Whether everybody sees our number on our profile; Signal-Desktop reads an unknown mode as nobody. */
  sharePhoneNumber: boolean;
  /** Whether people who have our number can find us by it. */
  findableByNumber: boolean;
  /** The default for mentions in muted chats; Signal treats unset as on. */
  notifyForMentionsIfMuted: boolean;
}

function fromOptionalBool(v: OptionalBool): boolean | undefined {
  return v === OptionalBool.ENABLED ? true : v === OptionalBool.DISABLED ? false : undefined;
}

/** Signal-Desktop's `resolveLegacyNotifyForMentionsIfMuted`: the deprecated "don't notify" wins when set, and an explicit "off" with the old field clear means an older client turned mentions back on. */
export function resolveLegacyNotifyForMentionsIfMuted(dontNotifyForMentionsIfMuted: boolean, notifyForMentionsIfMuted: boolean | undefined): boolean | undefined {
  if (dontNotifyForMentionsIfMuted) return false;
  if (notifyForMentionsIfMuted == null) return undefined;
  return true;
}

interface StorageSyncResult {
  version: number;
  contacts: StorageContactRecord[];
  groupsV2: StorageGroupV2Record[];
  account?: StorageAccountRecord;
}

function identityStateToTrust(state: ContactRecord_IdentityState): TrustLevel {
  switch (state) {
    case ContactRecord_IdentityState.VERIFIED: return 'TRUSTED_VERIFIED';
    case ContactRecord_IdentityState.UNVERIFIED: return 'UNTRUSTED';
    default: return 'TRUSTED_UNVERIFIED';
  }
}

function opt<T>(v: T, empty: T): T | undefined {
  return v === empty ? undefined : v;
}

const WANTED_TYPES = new Set([
  ManifestRecord_Identifier_Type.CONTACT,
  ManifestRecord_Identifier_Type.GROUPV2,
  ManifestRecord_Identifier_Type.ACCOUNT,
]);

export interface StorageSession {
  storageUrl: string;
  headers: Record<string, string>;
  storageKey: Uint8Array;
  deviceId: number;
}

export interface RemoteState {
  manifest: ManifestRecord;
  /** Decrypted records of the types we use, by base64 storage key. */
  records: Map<string, StorageRecord>;
}

export async function openSession(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  serverUrl: string,
  storageUrl: string
): Promise<StorageSession | null> {
  const acc = await store.getAccount();
  if (!acc || !acc.masterKey || acc.masterKey.length !== 32) return null;
  // SECURITY-REVIEW: storage credentials come from the chat server and are sent only to storage.signal.org as Basic auth.
  const cred = asObject(await httpJson('GET', '/v1/storage/auth', null, {
    baseUrl: serverUrl,
    basicAuth: accountBasicAuth(acc),
    timeout: 15000,
  }));
  if (!cred || typeof cred.username !== 'string' || typeof cred.password !== 'string') {
    throw new Error('Signal server returned no storage credentials');
  }
  return {
    storageUrl,
    headers: {
      Authorization: 'Basic ' + btoa(`${cred.username}:${cred.password}`),
      'Content-Type': 'application/x-protobuf',
    },
    storageKey: deriveStorageServiceKey(acc.masterKey),
    deviceId: acc.deviceId,
  };
}

/** Fetch and decrypt the manifest, reading only records whose storage keys aren't cached yet (a storage key always names the same record contents). */
export async function loadRemoteState(store: SignalProtocolStore, session: StorageSession, httpBinary: SignalHttpBinaryFn): Promise<RemoteState | null> {
  const manifestBytes = await httpBinary('GET', `${session.storageUrl}/v1/storage/manifest`, null, session.headers, 20000);
  if (manifestBytes.length === 0) return null;
  const sm = fromBinary(StorageManifestSchema, manifestBytes);
  const manifestPlain = await decryptStorageValue(deriveStorageManifestKey(session.storageKey, sm.version), sm.value);
  const manifest = fromBinary(ManifestRecordSchema, manifestPlain);
  if (manifest.version !== sm.version) throw new Error('Storage manifest version mismatch');

  const cached = ((await store.loadValue(STATE_KEY)) as Record<string, Uint8Array> | undefined) || {};
  const records = new Map<string, StorageRecord>();
  const missing: Uint8Array[] = [];
  for (const id of manifest.identifiers) {
    if (!WANTED_TYPES.has(id.type) || id.raw.length === 0) continue;
    const k = toBase64(id.raw);
    const hit = cached[k];
    if (hit instanceof Uint8Array) {
      try {
        records.set(k, fromBinary(StorageRecordSchema, hit));
        continue;
      } catch {
        // re-read a corrupt cache entry
      }
    }
    missing.push(id.raw);
  }

  const read: string[] = [];
  for (let i = 0; i < missing.length; i += READ_BATCH) {
    const batch = missing.slice(i, i + READ_BATCH);
    const readOp = toBinary(ReadOperationSchema, create(ReadOperationSchema, { readKey: batch }));
    const itemsBytes = await httpBinary('PUT', `${session.storageUrl}/v1/storage/read`, readOp, session.headers, 30000);
    for (const item of fromBinary(StorageItemsSchema, itemsBytes).items) {
      try {
        const itemKey = deriveStorageItemKey(session.storageKey, item.key, manifest.recordIkm);
        records.set(toBase64(item.key), fromBinary(StorageRecordSchema, await decryptStorageValue(itemKey, item.value)));
        read.push(toBase64(item.key));
      } catch {
        // undecryptable records stay in the manifest untouched
      }
    }
  }

  await saveRecordCache(store, records);
  const unreported = (await store.loadValue(UNREPORTED_KEY)) as string[] | undefined;
  if (read.length > 0 && unreported) await store.storeValue(UNREPORTED_KEY, unreported.concat(read));
  return { manifest, records };
}

export async function saveRecordCache(store: SignalProtocolStore, records: Map<string, StorageRecord>): Promise<void> {
  const out: Record<string, Uint8Array> = {};
  for (const [k, rec] of records) out[k] = toBinary(StorageRecordSchema, rec);
  await store.storeValue(STATE_KEY, out);
}

function toSyncResult(version: bigint, records: Map<string, StorageRecord>, unreported: Set<string>): StorageSyncResult {
  const result: StorageSyncResult = { version: num(version), contacts: [], groupsV2: [] };
  for (const [key, { record: rec }] of records) {
    const changed = unreported.has(key);
    if (rec.case === 'contact') {
      const c = rec.value;
      result.contacts.push({
        changed,
        aci: serviceIdFrom(c.aci, c.aciBinary) || undefined,
        e164: opt(c.e164, ''),
        pni: serviceIdFrom(c.pni, c.pniBinary) || undefined,
        profileKey: c.profileKey.length === 32 ? c.profileKey : undefined,
        identityKey: c.identityKey.length === 33 ? c.identityKey : undefined,
        identityState: c.identityKey.length === 33 ? identityStateToTrust(c.identityState) : undefined,
        givenName: opt(c.givenName, '') || opt(c.systemGivenName, ''),
        familyName: opt(c.familyName, '') || opt(c.systemFamilyName, ''),
        username: opt(c.username, ''),
        blocked: c.blocked,
        whitelisted: c.whitelisted,
        systemContact: !!(opt(c.systemGivenName, '') || opt(c.systemFamilyName, '')),
        archived: c.archived,
        markedUnread: c.markedUnread,
        mutedUntilTimestamp: num(c.mutedUntilTimestamp),
        nicknameGivenName: c.nickname ? opt(c.nickname.given, '') : undefined,
        nicknameFamilyName: c.nickname ? opt(c.nickname.family, '') : undefined,
      });
    } else if (rec.case === 'groupV2') {
      const g = rec.value;
      if (g.masterKey.length !== 32) continue;
      result.groupsV2.push({
        changed,
        masterKey: g.masterKey,
        blocked: g.blocked,
        whitelisted: g.whitelisted,
        archived: g.archived,
        markedUnread: g.markedUnread,
        mutedUntilTimestamp: num(g.mutedUntilTimestamp),
        notifyForMentionsIfMuted: resolveLegacyNotifyForMentionsIfMuted(g.dontNotifyForMentionsIfMuted, fromOptionalBool(g.notifyForMentionsIfMuted)),
      });
    } else if (rec.case === 'account') {
      const a = rec.value;
      const pinned: StoragePinnedConversation[] = [];
      for (const p of a.pinnedConversations) {
        const id = p.identifier;
        if (id.case === 'contact') {
          const aci = serviceIdFrom(id.value.serviceId, id.value.serviceIdBinary);
          pinned.push({ aci: aci || undefined, e164: opt(id.value.e164, '') });
        } else if (id.case === 'groupMasterKey' && id.value.length === 32) {
          pinned.push({ groupMasterKey: id.value });
        }
      }
      const link = a.usernameLink;
      result.account = {
        changed,
        profileKey: a.profileKey.length === 32 ? a.profileKey : undefined,
        givenName: opt(a.givenName, ''),
        familyName: opt(a.familyName, ''),
        avatarUrlPath: opt(a.avatarUrlPath, ''),
        readReceipts: a.readReceipts,
        typingIndicators: a.typingIndicators,
        linkPreviews: a.linkPreviews,
        sealedSenderIndicators: a.sealedSenderIndicators,
        universalExpireTimer: a.universalExpireTimer,
        username: opt(a.username, ''),
        usernameLink: link && link.entropy.length === 32 && link.serverId.length === 16 ? { entropy: link.entropy, serverId: link.serverId } : undefined,
        pinnedConversations: pinned,
        noteToSelfArchived: a.noteToSelfArchived,
        noteToSelfMarkedUnread: a.noteToSelfMarkedUnread,
        sharePhoneNumber: a.phoneNumberSharingMode === AccountRecord_PhoneNumberSharingMode.EVERYBODY,
        findableByNumber: !a.unlistedPhoneNumber,
        notifyForMentionsIfMuted: a.notifyForMentionsIfMuted !== OptionalBool.DISABLED,
      };
    }
  }
  return result;
}

/**
 * Pull and decrypt the full Storage Service state. Returns null when the account has no master key yet (the primary hasn't answered the Keys sync request) or the manifest is empty.
 */
export async function pullFromStorageService(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  httpBinary: SignalHttpBinaryFn,
  serverUrl: string,
  storageUrl = DEFAULT_STORAGE_SERVER
): Promise<StorageSyncResult | null> {
  const session = await openSession(store, httpJson, serverUrl, storageUrl);
  if (!session) return null;
  const remote = await loadRemoteState(store, session, httpBinary);
  if (!remote) return null;
  // Before the first pull every record counts as changed.
  const stored = (await store.loadValue(UNREPORTED_KEY)) as string[] | undefined;
  const unreported = new Set(stored || remote.records.keys());
  await store.storeValue(UNREPORTED_KEY, []);
  return toSyncResult(remote.manifest.version, remote.records, unreported);
}
