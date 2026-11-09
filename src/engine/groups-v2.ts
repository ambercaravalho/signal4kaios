/* Signal Groups V2 key derivation, metadata decryption, and GroupContextV2 management.
 *
 * Uses the 32-byte Group V2 `MasterKey` (received via Storage Service or `DataMessage.groupV2.masterKey`)
 * to deterministically derive:
 * - `groupIdentifier` (32 bytes): `HKDF-SHA256(masterKey, "20190524_Signal_Group_Identifier", 32)`
 * - `groupSecretKey` (32 bytes): `HKDF-SHA256(masterKey, "20190524_Signal_Group_Master_Secret", 32)`
 * - `blobEncryptionKey` (32 bytes): `HKDF-SHA256(groupSecretKey, "20200106_Signal_Group_Blob_Key", 32)`
 *
 * Also parses `GroupChange` / `DecryptedGroup` protobufs to extract group title, description,
 * member UUIDs, admin roles, disappearing timer, and permissions.
 */

import { bytesToUuid, concatBytes, fromBase64, toBase64 } from './bytes';
import { aesGcmDecrypt, aesGcmEncrypt, hkdfSha256 } from './crypto/primitives';
import { GroupContextV2, ProtoReader, ProtoWriter } from './proto';

const GROUP_ID_INFO = '20190524_Signal_Group_Identifier';
const GROUP_SECRET_INFO = '20190524_Signal_Group_Master_Secret';
const GROUP_BLOB_KEY_INFO = '20200106_Signal_Group_Blob_Key';

export interface DerivedGroupV2Keys {
  masterKey: Uint8Array;
  groupIdentifier: Uint8Array; // 32 bytes
  internalId: string;          // base64(groupIdentifier)
  sendId: string;              // 'group.' + base64(groupIdentifier)
  secretKey: Uint8Array;       // 32 bytes
  blobKey: Uint8Array;         // 32 bytes
}

export interface GroupV2Metadata {
  id: string;                  // 'group.' + internal_id
  internal_id: string;         // base64(groupIdentifier)
  masterKey: string;           // base64(32-byte masterKey)
  revision: number;
  name: string;
  description?: string;
  members: string[];           // member UUIDs / E164s
  admins: string[];            // admin UUIDs / E164s
  expireTimer: number;
  blocked: boolean;
  archived?: boolean;
  invite_link?: string;
  permissions?: {
    add_members: 'every-member' | 'only-admins';
    edit_group: 'every-member' | 'only-admins';
    send_messages: 'every-member' | 'only-admins';
  };
}

/**
 * Deterministically derive the Group V2 identifiers and symmetric keys from a 32-byte `MasterKey`.
 */
export function deriveGroupV2Keys(masterKey: Uint8Array): DerivedGroupV2Keys {
  if (masterKey.length !== 32) {
    throw new Error(`Invalid Group V2 masterKey length: ${masterKey.length}`);
  }
  const groupIdentifier = hkdfSha256(masterKey, GROUP_ID_INFO, 32);
  const secretKey = hkdfSha256(masterKey, GROUP_SECRET_INFO, 32);
  const blobKey = hkdfSha256(secretKey, GROUP_BLOB_KEY_INFO, 32);
  const internalId = toBase64(groupIdentifier);

  return {
    masterKey,
    groupIdentifier,
    internalId,
    sendId: 'group.' + internalId,
    secretKey,
    blobKey,
  };
}

/**
 * Encrypt a Group V2 blob (title, description, avatar) with the derived `blobKey` (AES-256-GCM).
 */
export async function encryptGroupV2Blob(
  blobKey32: Uint8Array,
  plaintext: Uint8Array,
  iv12: Uint8Array
): Promise<Uint8Array> {
  const cipherAndTag = await aesGcmEncrypt(blobKey32, iv12, plaintext);
  return concatBytes(iv12, cipherAndTag);
}

/**
 * Decrypt a Group V2 blob (12-byte IV || AES-GCM ciphertext + 16-byte tag) with `blobKey`.
 */
export async function decryptGroupV2Blob(
  blobKey32: Uint8Array,
  ivAndCiphertext: Uint8Array
): Promise<Uint8Array> {
  if (ivAndCiphertext.length < 12 + 16) {
    throw new Error('Encrypted Group V2 blob too short');
  }
  const iv = ivAndCiphertext.slice(0, 12);
  const cipherAndTag = ivAndCiphertext.slice(12);
  return aesGcmDecrypt(blobKey32, iv, cipherAndTag);
}

/**
 * Build an outbound `GroupContextV2` protobuf object for a Group V2 record.
 */
export function buildGroupContextV2(groupRecord: {
  masterKey?: string;
  revision?: number;
}): GroupContextV2 | undefined {
  if (!groupRecord.masterKey) return undefined;
  const mk = fromBase64(groupRecord.masterKey);
  if (mk.length !== 32) return undefined;
  return {
    masterKey: mk,
    revision: groupRecord.revision || 0,
  };
}

/**
 * Decode a DecryptedGroup / GroupChange state snapshot protobuf into partial `GroupV2Metadata`.
 * Fields:
 *   2: title (string)
 *   3: avatar (string)
 *   4: disappearingMessagesTimer { duration: uint32 (1) }
 *   5: accessControl { attributes (1), members (2), addFromInviteLink (3) }
 *   6: revision (uint32)
 *   7: members (repeated DecryptedMember { uuid (1), role (2) })
 *   11: description (string)
 */
export function decodeDecryptedGroupProto(
  buf: Uint8Array,
  masterKey: Uint8Array
): GroupV2Metadata {
  const keys = deriveGroupV2Keys(masterKey);
  const r = new ProtoReader(buf);

  let name = 'Group';
  let description = '';
  let revision = 0;
  let expireTimer = 0;
  const members: string[] = [];
  const admins: string[] = [];
  const permissions: NonNullable<GroupV2Metadata['permissions']> = {
    add_members: 'every-member',
    edit_group: 'only-admins',
    send_messages: 'every-member',
  };

  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    switch (fieldNumber) {
      case 2:
        name = r.readString() || name;
        break;
      case 4: {
        const tr = new ProtoReader(r.readBytes());
        while (!tr.eof()) {
          const tt = tr.readTag();
          if (tt.fieldNumber === 1) expireTimer = tr.readUint32();
          else tr.skipField(tt.wireType);
        }
        break;
      }
      case 5: {
        const acr = new ProtoReader(r.readBytes());
        while (!acr.eof()) {
          const act = acr.readTag();
          if (act.fieldNumber === 1) {
            const v = acr.readUint32();
            permissions.edit_group = v === 3 ? 'only-admins' : 'every-member';
          } else if (act.fieldNumber === 2) {
            const v = acr.readUint32();
            permissions.add_members = v === 3 ? 'only-admins' : 'every-member';
          } else {
            acr.skipField(act.wireType);
          }
        }
        break;
      }
      case 6:
        revision = r.readUint32();
        break;
      case 7: {
        const mr = new ProtoReader(r.readBytes());
        let uuid = '';
        let role = 1; // 1 = DEFAULT, 2 = ADMINISTRATOR
        while (!mr.eof()) {
          const mt = mr.readTag();
          if (mt.fieldNumber === 1) {
            const raw = mr.readBytes();
            uuid = raw.length === 16 ? bytesToUuid(raw) : new TextDecoder().decode(raw);
          } else if (mt.fieldNumber === 2) {
            role = mr.readUint32();
          } else {
            mr.skipField(mt.wireType);
          }
        }
        if (uuid) {
          members.push(uuid);
          if (role === 2) admins.push(uuid);
        }
        break;
      }
      case 11:
        description = r.readString();
        break;
      default:
        r.skipField(wireType);
    }
  }

  return {
    id: keys.sendId,
    internal_id: keys.internalId,
    masterKey: toBase64(masterKey),
    revision,
    name,
    description,
    members,
    admins,
    expireTimer,
    blocked: false,
    permissions,
  };
}

export function encodeDecryptedGroupProto(meta: {
  name: string;
  description?: string;
  revision?: number;
  expireTimer?: number;
  members?: Array<{ uuid: string; isAdmin?: boolean }>;
}): Uint8Array {
  const w = new ProtoWriter();
  w.writeString(2, meta.name);
  if (meta.expireTimer !== undefined) {
    w.writeMessage(4, meta.expireTimer, (t, tw) => tw.writeUint32(1, t));
  }
  w.writeUint32(6, meta.revision || 0);
  for (const m of meta.members || []) {
    w.writeMessage(7, m, (mem, mw) => {
      mw.writeString(1, mem.uuid);
      mw.writeUint32(2, mem.isAdmin ? 2 : 1);
    });
  }
  if (meta.description !== undefined) {
    w.writeString(11, meta.description);
  }
  return w.finish();
}
