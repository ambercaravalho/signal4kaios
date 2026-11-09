/* Signal Encrypted Storage Service (SVR / StorageManifest / StorageItem / ContactRecord / GroupV2Record / AccountRecord).
 *
 * Uses the 32-byte `masterKey` transferred during Linked Device provisioning (`ProvisionMessage.masterKey`)
 * to derive the Storage Service Key (`HKDF-SHA256(masterKey, "20200310_SIGNAL_STORAGE_SERVICE_KEY", 32)`)
 * and Item keys (`HKDF-SHA256(storageServiceKey, "20200310_SIGNAL_STORAGE_SERVICE_ITEM_KEY_" || base64(itemKey), 32)`).
 * Decrypts AES-256-GCM StorageManifest and StorageItems (ContactRecord, GroupV2Record, AccountRecord).
 */

import { concatBytes, fromBase64, randomBytes, toBase64, bytesToUuid } from './bytes';
import { aesGcmDecrypt, aesGcmEncrypt, hkdfSha256 } from './crypto/primitives';
import { ProtoReader, ProtoWriter, WIRE_BYTES, WIRE_VARINT } from './proto';
import type { SignalHttpJsonFn } from './provisioning';
import type { SignalProtocolStore, TrustLevel } from './storage';

const STORAGE_SERVICE_KEY_INFO = '20200310_SIGNAL_STORAGE_SERVICE_KEY';
const STORAGE_ITEM_KEY_PREFIX = '20200310_SIGNAL_STORAGE_SERVICE_ITEM_KEY_';

export enum StorageKeyType {
  UNKNOWN = 0,
  CONTACT = 1,
  GROUP_V1 = 2,
  GROUP_V2 = 3,
  ACCOUNT = 4,
  STORY_DISTRIBUTION_LIST = 5,
}

export interface StorageManifestKeyEntry {
  type: StorageKeyType;
  key: Uint8Array;
}

export interface DecryptedStorageManifest {
  version: number;
  sourceDevice: number;
  keys: StorageManifestKeyEntry[];
}

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
  noteToSelfArchived?: boolean;
  readReceipts?: boolean;
  typingIndicators?: boolean;
  pinnedConversations: Array<{
    contactUuid?: string;
    contactE164?: string;
    groupMasterKey?: Uint8Array;
  }>;
  username?: string;
}

export interface StorageSyncResult {
  version: number;
  contacts: StorageContactRecord[];
  groupsV2: StorageGroupV2Record[];
  account?: StorageAccountRecord;
}

/**
 * Derive the 32-byte Storage Service Key from the 32-byte `masterKey`.
 */
export function deriveStorageServiceKey(masterKey32: Uint8Array): Uint8Array {
  if (masterKey32.length !== 32) {
    throw new Error(`Invalid masterKey length: ${masterKey32.length}`);
  }
  return hkdfSha256(masterKey32, STORAGE_SERVICE_KEY_INFO, 32);
}

/**
 * Derive the 32-byte item encryption key for a specific `storageItemKey` (16 bytes).
 */
export function deriveStorageItemKey(
  storageServiceKey32: Uint8Array,
  itemKey: Uint8Array
): Uint8Array {
  const info = STORAGE_ITEM_KEY_PREFIX + toBase64(itemKey);
  return hkdfSha256(storageServiceKey32, info, 32);
}

/**
 * Encrypt a plaintext payload with a Storage Service key (12-byte IV || AES-GCM ciphertext + 16-byte tag).
 */
export async function encryptStorageRecord(
  key32: Uint8Array,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const cipherAndTag = await aesGcmEncrypt(key32, iv, plaintext);
  return concatBytes(iv, cipherAndTag);
}

/**
 * Decrypt a Storage Service record (12-byte IV || AES-GCM ciphertext + 16-byte tag).
 */
export async function decryptStorageRecord(
  key32: Uint8Array,
  ivAndCiphertext: Uint8Array
): Promise<Uint8Array> {
  if (ivAndCiphertext.length < 12 + 16) {
    throw new Error('Encrypted storage record too short');
  }
  const iv = ivAndCiphertext.slice(0, 12);
  const cipherAndTag = ivAndCiphertext.slice(12);
  return aesGcmDecrypt(key32, iv, cipherAndTag);
}

function mapIdentityState(stateNum: number): TrustLevel {
  if (stateNum === 1) return 'TRUSTED_VERIFIED';
  if (stateNum === 2) return 'UNTRUSTED';
  return 'TRUSTED_UNVERIFIED';
}

export function decodeManifestRecord(buf: Uint8Array): DecryptedStorageManifest {
  const r = new ProtoReader(buf);
  let version = 0;
  let sourceDevice = 1;
  const keys: StorageManifestKeyEntry[] = [];

  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1:
        version = r.readVarintNumber();
        break;
      case 2: {
        const kr = new ProtoReader(r.readBytes());
        let kType = StorageKeyType.UNKNOWN;
        let kBytes: Uint8Array | undefined;
        while (!kr.eof()) {
          const kt = kr.readTag();
          if (kt.fieldNumber === 1) kBytes = kr.readBytes();
          else if (kt.fieldNumber === 2) kType = kr.readUint32() as StorageKeyType;
          else kr.skipField(kt.wireType);
        }
        if (kBytes) keys.push({ type: kType, key: kBytes });
        break;
      }
      case 3:
        sourceDevice = r.readUint32();
        break;
      default:
        r.skipField(wireType);
    }
  }
  return { version, sourceDevice, keys };
}

export function encodeManifestRecord(manifest: DecryptedStorageManifest): Uint8Array {
  const w = new ProtoWriter();
  w.writeUint64(1, manifest.version);
  for (const k of manifest.keys) {
    w.writeMessage(2, k, (entry, kw) => {
      kw.writeBytes(1, entry.key);
      kw.writeUint32(2, entry.type);
    });
  }
  w.writeUint32(3, manifest.sourceDevice);
  return w.finish();
}

export function decodeStorageContactRecord(buf: Uint8Array): StorageContactRecord {
  const r = new ProtoReader(buf);
  const out: StorageContactRecord = {};
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: {
        const raw = r.readBytes();
        out.aci = raw.length === 16 ? bytesToUuid(raw) : new TextDecoder().decode(raw);
        break;
      }
      case 2: out.e164 = r.readString(); break;
      case 3: out.profileKey = r.readBytes(); break;
      case 4: out.identityKey = r.readBytes(); break;
      case 5: out.identityState = mapIdentityState(r.readUint32()); break;
      case 6: out.givenName = r.readString(); break;
      case 7: out.familyName = r.readString(); break;
      case 8: out.username = r.readString(); break;
      case 9: out.blocked = r.readBool(); break;
      case 10: out.whitelisted = r.readBool(); break;
      case 11: out.archived = r.readBool(); break;
      case 12: out.markedUnread = r.readBool(); break;
      case 13: out.mutedUntilTimestamp = r.readVarintNumber(); break;
      case 16: {
        const raw = r.readBytes();
        out.pni = raw.length === 16 ? bytesToUuid(raw) : new TextDecoder().decode(raw);
        break;
      }
      case 22: {
        const nr = new ProtoReader(r.readBytes());
        while (!nr.eof()) {
          const nt = nr.readTag();
          if (nt.fieldNumber === 1) out.nicknameGivenName = nr.readString();
          else if (nt.fieldNumber === 2) out.nicknameFamilyName = nr.readString();
          else nr.skipField(nt.wireType);
        }
        break;
      }
      default: r.skipField(wireType);
    }
  }
  return out;
}

export function decodeStorageGroupV2Record(buf: Uint8Array): StorageGroupV2Record | null {
  const r = new ProtoReader(buf);
  let masterKey: Uint8Array | undefined;
  let blocked = false;
  let whitelisted = false;
  let archived = false;
  let markedUnread = false;
  let mutedUntilTimestamp = 0;

  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: masterKey = r.readBytes(); break;
      case 2: blocked = r.readBool(); break;
      case 3: whitelisted = r.readBool(); break;
      case 4: archived = r.readBool(); break;
      case 5: markedUnread = r.readBool(); break;
      case 6: mutedUntilTimestamp = r.readVarintNumber(); break;
      default: r.skipField(wireType);
    }
  }
  if (!masterKey || masterKey.length !== 32) return null;
  return {
    masterKey,
    blocked,
    whitelisted,
    archived,
    markedUnread,
    mutedUntilTimestamp,
  };
}

export function decodeStorageAccountRecord(buf: Uint8Array): StorageAccountRecord {
  const r = new ProtoReader(buf);
  const out: StorageAccountRecord = { pinnedConversations: [] };
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.profileKey = r.readBytes(); break;
      case 2: out.givenName = r.readString(); break;
      case 3: out.familyName = r.readString(); break;
      case 4: out.avatarUrlPath = r.readString(); break;
      case 5: out.noteToSelfArchived = r.readBool(); break;
      case 6: out.readReceipts = r.readBool(); break;
      case 8: out.typingIndicators = r.readBool(); break;
      case 14: {
        const pr = new ProtoReader(r.readBytes());
        while (!pr.eof()) {
          const pt = pr.readTag();
          if (pt.fieldNumber === 1) {
            const cr = new ProtoReader(pr.readBytes());
            let uuid: string | undefined;
            let e164: string | undefined;
            while (!cr.eof()) {
              const ct = cr.readTag();
              if (ct.fieldNumber === 1) uuid = cr.readString();
              else if (ct.fieldNumber === 2) e164 = cr.readString();
              else cr.skipField(ct.wireType);
            }
            out.pinnedConversations.push({ contactUuid: uuid, contactE164: e164 });
          } else if (pt.fieldNumber === 3) {
            out.pinnedConversations.push({ groupMasterKey: pr.readBytes() });
          } else {
            pr.skipField(pt.wireType);
          }
        }
        break;
      }
      case 22: out.username = r.readString(); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

export function decodeStorageRecordWrapper(buf: Uint8Array): {
  contact?: StorageContactRecord;
  groupV2?: StorageGroupV2Record | null;
  account?: StorageAccountRecord;
} {
  const r = new ProtoReader(buf);
  const out: {
    contact?: StorageContactRecord;
    groupV2?: StorageGroupV2Record | null;
    account?: StorageAccountRecord;
  } = {};

  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 1: out.contact = decodeStorageContactRecord(r.readBytes()); break;
      case 3: out.groupV2 = decodeStorageGroupV2Record(r.readBytes()); break;
      case 4: out.account = decodeStorageAccountRecord(r.readBytes()); break;
      default: r.skipField(wireType);
    }
  }
  return out;
}

/**
 * Encode a StorageRecord wrapper (used in tests and Storage Service updates).
 */
export function encodeStorageContactRecord(c: StorageContactRecord): Uint8Array {
  const inner = new ProtoWriter();
  inner.writeString(1, c.aci);
  inner.writeString(2, c.e164);
  inner.writeBytes(3, c.profileKey);
  inner.writeBytes(4, c.identityKey);
  inner.writeString(6, c.givenName);
  inner.writeString(7, c.familyName);
  inner.writeString(8, c.username);
  inner.writeBool(9, c.blocked);
  inner.writeBool(11, c.archived);

  const outer = new ProtoWriter();
  outer.writeBytes(1, inner.finish());
  return outer.finish();
}

export function encodeStorageGroupV2Record(g: StorageGroupV2Record): Uint8Array {
  const inner = new ProtoWriter();
  inner.writeBytes(1, g.masterKey);
  inner.writeBool(2, g.blocked);
  inner.writeBool(4, g.archived);

  const outer = new ProtoWriter();
  outer.writeBytes(3, inner.finish());
  return outer.finish();
}

/**
 * Pull and decrypt the user's StorageManifest and StorageItems from Signal's Storage Service.
 */
export async function pullFromStorageService(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  serverUrl: string
): Promise<StorageSyncResult | null> {
  const acc = await store.getAccount();
  if (!acc || !acc.masterKey || acc.masterKey.length !== 32) {
    return null;
  }

  const storageServiceKey = deriveStorageServiceKey(acc.masterKey);
  const auth = { username: `${acc.aci}.${acc.deviceId}`, password: acc.password };

  // 1. Obtain short-lived storage credentials from GET /v1/storage/auth
  const storageAuth = await httpJson('GET', '/v1/storage/auth', null, {
    baseUrl: serverUrl,
    basicAuth: auth,
    timeout: 15000,
  });

  const storageCreds =
    storageAuth && storageAuth.username && storageAuth.password
      ? { username: storageAuth.username, password: storageAuth.password }
      : auth;

  // 2. Fetch encrypted StorageManifest from GET /v1/storage/manifest
  const manifestRes = await httpJson('GET', '/v1/storage/manifest', null, {
    baseUrl: serverUrl,
    basicAuth: storageCreds,
    timeout: 15000,
  });
  if (!manifestRes || !manifestRes.value) return null;

  const encryptedManifest = fromBase64(manifestRes.value);
  const decryptedManifestBytes = await decryptStorageRecord(
    storageServiceKey,
    encryptedManifest
  );
  const manifest = decodeManifestRecord(decryptedManifestBytes);

  const targetKeys = manifest.keys.filter(
    (k) =>
      k.type === StorageKeyType.CONTACT ||
      k.type === StorageKeyType.GROUP_V2 ||
      k.type === StorageKeyType.ACCOUNT
  );
  if (targetKeys.length === 0) {
    return { version: manifest.version, contacts: [], groupsV2: [] };
  }

  // 3. Read StorageItems via PUT /v1/storage/read
  const readRes = await httpJson(
    'PUT',
    '/v1/storage/read',
    {
      keys: targetKeys.map((k) => toBase64(k.key)),
    },
    {
      baseUrl: serverUrl,
      basicAuth: storageCreds,
      timeout: 25000,
    }
  );

  const contacts: StorageContactRecord[] = [];
  const groupsV2: StorageGroupV2Record[] = [];
  let accountRecord: StorageAccountRecord | undefined;

  const items: Array<{ key: string; value: string }> =
    (readRes && Array.isArray(readRes.items) && readRes.items) || [];

  for (const item of items) {
    if (!item.key || !item.value) continue;
    try {
      const itemKeyBytes = fromBase64(item.key);
      const itemKey = deriveStorageItemKey(storageServiceKey, itemKeyBytes);
      const plainBytes = await decryptStorageRecord(
        itemKey,
        fromBase64(item.value)
      );
      const decoded = decodeStorageRecordWrapper(plainBytes);
      if (decoded.contact) contacts.push(decoded.contact);
      if (decoded.groupV2) groupsV2.push(decoded.groupV2);
      if (decoded.account) accountRecord = decoded.account;
    } catch {
      // Skip unreadable individual storage item
    }
  }

  return {
    version: manifest.version,
    contacts,
    groupsV2,
    account: accountRecord,
  };
}
