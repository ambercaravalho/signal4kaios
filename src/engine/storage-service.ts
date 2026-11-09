/* Signal Storage Service (read-only): contacts, Groups V2 master keys, and account settings from the encrypted manifest on storage.signal.org. Key derivation and record layout follow Signal-Desktop's Crypto.node.ts and services/storage.preload.ts. */

import { concatBytes, toBase64 } from './bytes';
import { aesGcmDecrypt, hkdfSha256, hmacSha256 } from './crypto/primitives';
import {
  ContactRecord_IdentityState,
  ManifestRecord_Identifier_Type,
  ManifestRecordSchema,
  ReadOperationSchema,
  StorageItemsSchema,
  StorageManifestSchema,
  StorageRecordSchema,
} from './gen/SignalStorage_pb';
import { DEFAULT_STORAGE_SERVER } from './groups-v2';
import { create, fromBinary, num, serviceIdFrom, toBinary } from './proto';
import type { SignalHttpJsonFn } from './provisioning';
import type { SignalProtocolStore, TrustLevel } from './storage';
import type { SignalHttpBinaryFn } from './transport';

const enc = new TextEncoder();
const ITEM_KEY_INFO_PREFIX = '20240801_SIGNAL_STORAGE_SERVICE_ITEM_';
const READ_BATCH = 1024;

export interface StorageContactRecord {
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
  masterKey: Uint8Array;
  blocked?: boolean;
  whitelisted?: boolean;
  archived?: boolean;
  markedUnread?: boolean;
  mutedUntilTimestamp?: number;
}

export interface StorageAccountRecord {
  profileKey?: Uint8Array;
  givenName?: string;
  familyName?: string;
  avatarUrlPath?: string;
  readReceipts?: boolean;
  typingIndicators?: boolean;
  username?: string;
}

export interface StorageSyncResult {
  version: number;
  contacts: StorageContactRecord[];
  groupsV2: StorageGroupV2Record[];
  account?: StorageAccountRecord;
}

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
  const headers = {
    Authorization: 'Basic ' + btoa(`${cred.username}:${cred.password}`),
    'Content-Type': 'application/x-protobuf',
  };

  const manifestBytes = await httpBinary('GET', `${storageUrl}/v1/storage/manifest`, null, headers, 20000);
  if (manifestBytes.length === 0) return null;
  const manifest = fromBinary(StorageManifestSchema, manifestBytes);
  const storageKey = deriveStorageServiceKey(acc.masterKey);
  const manifestPlain = await decryptStorageValue(deriveStorageManifestKey(storageKey, manifest.version), manifest.value);
  const record = fromBinary(ManifestRecordSchema, manifestPlain);

  const wanted = new Set([
    ManifestRecord_Identifier_Type.CONTACT,
    ManifestRecord_Identifier_Type.GROUPV2,
    ManifestRecord_Identifier_Type.ACCOUNT,
  ]);
  const ids = record.identifiers.filter((i) => wanted.has(i.type) && i.raw.length > 0);

  const result: StorageSyncResult = { version: num(manifest.version), contacts: [], groupsV2: [] };
  for (let i = 0; i < ids.length; i += READ_BATCH) {
    const batch = ids.slice(i, i + READ_BATCH);
    const readOp = toBinary(ReadOperationSchema, create(ReadOperationSchema, { readKey: batch.map((b) => b.raw) }));
    const itemsBytes = await httpBinary('PUT', `${storageUrl}/v1/storage/read`, readOp, headers, 30000);
    const items = fromBinary(StorageItemsSchema, itemsBytes).items;
    for (const item of items) {
      let rec;
      try {
        const itemKey = deriveStorageItemKey(storageKey, item.key, record.recordIkm);
        rec = fromBinary(StorageRecordSchema, await decryptStorageValue(itemKey, item.value)).record;
      } catch {
        continue;
      }
      if (rec.case === 'contact') {
        const c = rec.value;
        result.contacts.push({
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
          masterKey: g.masterKey,
          blocked: g.blocked,
          whitelisted: g.whitelisted,
          archived: g.archived,
          markedUnread: g.markedUnread,
          mutedUntilTimestamp: num(g.mutedUntilTimestamp),
        });
      } else if (rec.case === 'account') {
        const a = rec.value;
        result.account = {
          profileKey: a.profileKey.length === 32 ? a.profileKey : undefined,
          givenName: opt(a.givenName, ''),
          familyName: opt(a.familyName, ''),
          avatarUrlPath: opt(a.avatarUrlPath, ''),
          readReceipts: a.readReceipts,
          typingIndicators: a.typingIndicators,
          username: opt(a.username, ''),
        };
      }
    }
  }
  return result;
}
