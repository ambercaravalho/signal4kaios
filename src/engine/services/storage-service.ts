/* Signal Storage Service: contacts, Groups V2, and account settings in the encrypted manifest on storage.signal.org, read and written the way Signal-Desktop's services/storage.preload.ts does. Key derivation and record layout follow Signal-Desktop's Crypto.node.ts. */

import { concatBytes, constantTimeEqual, randomBytes, toBase64, uuidToBytes } from '../bytes';
import { aesGcmDecrypt, aesGcmEncrypt, hkdfSha256, hmacSha256 } from '../crypto/primitives';
import {
  AccountRecord,
  ContactRecord,
  ContactRecord_IdentityState,
  GroupV2Record,
  ManifestRecord,
  ManifestRecord_Identifier_Type,
  ManifestRecord_IdentifierSchema,
  ManifestRecordSchema,
  ReadOperationSchema,
  StorageItemsSchema,
  StorageManifestSchema,
  StorageRecord,
  StorageRecordSchema,
  WriteOperationSchema,
} from '../gen/SignalStorage_pb';
import { create, fromBinary, num, serviceIdFrom, toBinary } from '../net/proto';
import type { SignalProtocolStore, TrustLevel } from '../protocol/store';
import { DEFAULT_STORAGE_SERVER, SignalHttpBinaryFn, SignalHttpJsonFn } from '../net/http';

const enc = new TextEncoder();
const ITEM_KEY_INFO_PREFIX = '20240801_SIGNAL_STORAGE_SERVICE_ITEM_';
const READ_BATCH = 1024;
const WRITE_ATTEMPTS = 3;
const STATE_KEY = 'storageServiceRecords';
/** Keys of records read from the server (written by another device) that no pull has reported yet. A write also reads new records, so this outlives one call. Unset until the first pull. */
const UNREPORTED_KEY = 'storageServiceUnreported';

export interface StorageContactRecord {
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
  whitelisted?: boolean;
  archived?: boolean;
  markedUnread?: boolean;
  mutedUntilTimestamp?: number;
  nicknameGivenName?: string;
  nicknameFamilyName?: string;
}

export interface StorageGroupV2Record {
  changed: boolean;
  masterKey: Uint8Array;
  blocked?: boolean;
  whitelisted?: boolean;
  archived?: boolean;
  markedUnread?: boolean;
  mutedUntilTimestamp?: number;
}

export interface StoragePinnedConversation {
  aci?: string;
  e164?: string;
  groupMasterKey?: Uint8Array;
}

export interface StorageAccountRecord {
  changed: boolean;
  profileKey?: Uint8Array;
  givenName?: string;
  familyName?: string;
  avatarUrlPath?: string;
  readReceipts?: boolean;
  typingIndicators?: boolean;
  username?: string;
  usernameLink?: { entropy: Uint8Array; serverId: Uint8Array };
  pinnedConversations: StoragePinnedConversation[];
  noteToSelfArchived?: boolean;
  noteToSelfMarkedUnread?: boolean;
}

export interface StorageSyncResult {
  version: number;
  contacts: StorageContactRecord[];
  groupsV2: StorageGroupV2Record[];
  account?: StorageAccountRecord;
}

/** One change to a Storage Service record. A missing contact or group record is created; the account record must already exist. */
export type StorageMutation =
  | { type: 'contact'; aci?: string; e164?: string; update: (c: ContactRecord) => void }
  | { type: 'groupV2'; masterKey: Uint8Array; update: (g: GroupV2Record) => void }
  | { type: 'account'; update: (a: AccountRecord) => void };

export function deriveStorageServiceKey(masterKey: Uint8Array): Uint8Array {
  if (masterKey.length !== 32) throw new Error(`Invalid masterKey length: ${masterKey.length}`);
  return hmacSha256(masterKey, enc.encode('Storage Service Encryption'));
}

export function deriveStorageManifestKey(storageServiceKey: Uint8Array, version: bigint): Uint8Array {
  return hmacSha256(storageServiceKey, enc.encode(`Manifest_${version}`));
}

export function deriveStorageItemKey(storageServiceKey: Uint8Array, key: Uint8Array, recordIkm?: Uint8Array): Uint8Array {
  if (!recordIkm || recordIkm.length === 0) {
    return hmacSha256(storageServiceKey, enc.encode(`Item_${toBase64(key)}`));
  }
  return hkdfSha256(recordIkm, concatBytes(enc.encode(ITEM_KEY_INFO_PREFIX), key), 32, new Uint8Array(0));
}

/** AES-256-GCM with a 12-byte IV prefix (Signal-Desktop decryptProfile, also used for storage records). */
export async function decryptStorageValue(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 12 + 16) throw new Error('Encrypted storage value too short');
  return aesGcmDecrypt(key, data.subarray(0, 12), data.subarray(12));
}

export async function encryptStorageValue(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(12);
  return concatBytes(iv, await aesGcmEncrypt(key, iv, plaintext));
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

interface StorageSession {
  storageUrl: string;
  headers: Record<string, string>;
  storageKey: Uint8Array;
  deviceId: number;
}

interface RemoteState {
  manifest: ManifestRecord;
  /** Decrypted records of the types we use, by base64 storage key. */
  records: Map<string, StorageRecord>;
}

async function openSession(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  serverUrl: string,
  storageUrl: string
): Promise<StorageSession | null> {
  const acc = await store.getAccount();
  if (!acc || !acc.masterKey || acc.masterKey.length !== 32) return null;
  // SECURITY-REVIEW: storage credentials come from the chat server and are sent only to storage.signal.org as Basic auth.
  const cred = await httpJson('GET', '/v1/storage/auth', null, {
    baseUrl: serverUrl,
    basicAuth: { username: `${acc.aci}.${acc.deviceId}`, password: acc.password },
    timeout: 15000,
  });
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
async function loadRemoteState(store: SignalProtocolStore, session: StorageSession, httpBinary: SignalHttpBinaryFn): Promise<RemoteState | null> {
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

async function saveRecordCache(store: SignalProtocolStore, records: Map<string, StorageRecord>): Promise<void> {
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
        username: opt(a.username, ''),
        usernameLink: link && link.entropy.length === 32 && link.serverId.length === 16 ? { entropy: link.entropy, serverId: link.serverId } : undefined,
        pinnedConversations: pinned,
        noteToSelfArchived: a.noteToSelfArchived,
        noteToSelfMarkedUnread: a.noteToSelfMarkedUnread,
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

interface WorkingRecord {
  key: Uint8Array | null;
  type: ManifestRecord_Identifier_Type;
  record: StorageRecord;
  before: Uint8Array | null;
}

function findWorking(list: WorkingRecord[], m: StorageMutation): WorkingRecord | undefined {
  return list.find(({ record: { record: r } }) => {
    if (m.type === 'account') return r.case === 'account';
    if (m.type === 'groupV2') return r.case === 'groupV2' && constantTimeEqual(r.value.masterKey, m.masterKey);
    if (r.case !== 'contact') return false;
    const aci = serviceIdFrom(r.value.aci, r.value.aciBinary);
    if (aci && m.aci) return aci === m.aci;
    return !!m.e164 && r.value.e164 === m.e164;
  });
}

function newWorking(m: StorageMutation): WorkingRecord {
  if (m.type === 'account') throw new Error('Storage Service has no account record yet');
  if (m.type === 'groupV2') {
    return {
      key: null,
      type: ManifestRecord_Identifier_Type.GROUPV2,
      record: create(StorageRecordSchema, { record: { case: 'groupV2', value: { masterKey: m.masterKey } } }),
      before: null,
    };
  }
  if (!m.aci && !m.e164) throw new Error('A contact record needs an ACI or a phone number');
  return {
    key: null,
    type: ManifestRecord_Identifier_Type.CONTACT,
    record: create(StorageRecordSchema, {
      record: {
        case: 'contact',
        value: { aci: m.aci || '', aciBinary: m.aci ? uuidToBytes(m.aci) : undefined, e164: m.e164 || '' },
      },
    }),
    before: null,
  };
}

function applyMutation(w: WorkingRecord, m: StorageMutation): void {
  const r = w.record.record;
  if (m.type === 'contact' && r.case === 'contact') m.update(r.value);
  else if (m.type === 'groupV2' && r.case === 'groupV2') m.update(r.value);
  else if (m.type === 'account' && r.case === 'account') m.update(r.value);
}

/**
 * Apply `mutations` to the latest Storage Service records and write them back like Signal-Desktop: every changed record gets a fresh random 16-byte key, the old key is deleted, and a manifest at version+1 lists the new keys alongside every identifier we don't touch (including record types we never read). A 409 means another device wrote first, so the state is re-read and the mutations re-applied. Resolves to false when nothing changed.
 */
export async function mutateStorage(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  httpBinary: SignalHttpBinaryFn,
  serverUrl: string,
  mutations: StorageMutation[],
  storageUrl = DEFAULT_STORAGE_SERVER
): Promise<boolean> {
  if (mutations.length === 0) return false;
  for (let attempt = 0; ; attempt++) {
    const session = await openSession(store, httpJson, serverUrl, storageUrl);
    if (!session) throw new Error('Storage Service needs the account master key; sync with your phone first');
    const remote = await loadRemoteState(store, session, httpBinary);
    if (!remote) throw new Error('Storage Service has no manifest yet');

    const working: WorkingRecord[] = [];
    for (const id of remote.manifest.identifiers) {
      const rec = id.raw.length ? remote.records.get(toBase64(id.raw)) : undefined;
      if (rec) working.push({ key: id.raw, type: id.type, record: rec, before: toBinary(StorageRecordSchema, rec) });
    }
    for (const m of mutations) {
      let w = findWorking(working, m);
      if (!w) {
        w = newWorking(m);
        working.push(w);
      }
      applyMutation(w, m);
    }

    const changed = working.filter((w) => {
      const now = toBinary(StorageRecordSchema, w.record);
      return !w.before || !constantTimeEqual(w.before, now);
    });
    if (changed.length === 0) return false;

    const manifest = remote.manifest;
    const newVersion = manifest.version + 1n;
    const deleteKey = changed.filter((w) => w.key).map((w) => w.key!);
    const deleted = new Set(deleteKey.map(toBase64));
    const insertItem = [];
    const nextRecords = new Map(remote.records);
    for (const k of deleted) nextRecords.delete(k);
    const identifiers = manifest.identifiers.filter((id) => !deleted.has(toBase64(id.raw)));
    for (const w of changed) {
      const key = randomBytes(16);
      const plain = toBinary(StorageRecordSchema, w.record);
      const itemKey = deriveStorageItemKey(session.storageKey, key, manifest.recordIkm);
      insertItem.push({ key, value: await encryptStorageValue(itemKey, plain) });
      identifiers.push(create(ManifestRecord_IdentifierSchema, { raw: key, type: w.type }));
      nextRecords.set(toBase64(key), w.record);
    }
    manifest.version = newVersion;
    manifest.sourceDevice = session.deviceId;
    manifest.identifiers = identifiers;

    const manifestValue = await encryptStorageValue(
      deriveStorageManifestKey(session.storageKey, newVersion),
      toBinary(ManifestRecordSchema, manifest)
    );
    const writeOp = create(WriteOperationSchema, {
      manifest: { version: newVersion, value: manifestValue },
      insertItem,
      deleteKey,
    });
    try {
      await httpBinary('PUT', `${storageUrl}/v1/storage`, toBinary(WriteOperationSchema, writeOp), session.headers, 30000);
    } catch (err: any) {
      if (err && err.status === 409 && attempt + 1 < WRITE_ATTEMPTS) continue;
      throw err;
    }
    await saveRecordCache(store, nextRecords);
    return true;
  }
}

/**
 * Batches Storage Service mutations: changes queued within `delayMs` go out as one manifest write, and writes never overlap. `onWritten` runs after each write that changed something.
 */
export class StorageWriteQueue {
  private pending: StorageMutation[] = [];
  private batch: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly write: (mutations: StorageMutation[]) => Promise<boolean>,
    private readonly onWritten: () => void,
    private readonly delayMs = 1500
  ) {}

  enqueue(mutations: StorageMutation[]): Promise<void> {
    this.pending.push(...mutations);
    if (!this.batch) {
      this.batch = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          const muts = this.pending;
          this.pending = [];
          this.batch = null;
          const job = this.chain.then(() => this.write(muts));
          this.chain = job.catch(() => undefined);
          job.then((changed) => {
            if (changed) this.onWritten();
            resolve();
          }, reject);
        }, this.delayMs);
      });
    }
    return this.batch;
  }
}
