/* Signal Groups V2 via zkgroup (libsignal wasm): group identifiers, encrypted group state from the storage server, invite links, and GroupContextV2 for outgoing messages. Follows Signal-Desktop's groups.preload.ts and WebAPI getGroup/getGroupCredentials. Changes live in group-changes.ts. */

import { fromBase64, toBase64, toHex, toWebSafeBase64 } from '../bytes';
import {
  AccessControl_AccessRequired,
  Group,
  GroupAttributeBlobSchema,
  GroupInviteLinkSchema,
  GroupResponseSchema,
  Member_Role,
} from '../gen/Groups_pb';
import type { GroupContextV2 } from '../gen/SignalService_pb';
import { GroupContextV2Schema } from '../gen/SignalService_pb';
import { libsignal } from '../protocol/libsignal';
import { create, fromBinary, toBinary } from '../net/proto';
import { accountBasicAuth, asObject, DEFAULT_STORAGE_SERVER, SignalHttpBinaryFn, SignalHttpJsonFn } from '../net/http';
import type { SignalProtocolStore } from '../protocol/store';
import { storeGroupSendEndorsements } from './group-send';

/** zkgroup ServerPublicParams for Signal production (Signal-Desktop config/production.json). */
export const SERVER_PUBLIC_PARAMS = fromBase64(
  'AMhf5ywVwITZMsff/eCyudZx9JDmkkkbV6PInzG4p8x3VqVJSFiMvnvlEKWuRob/1eaIetR31IYeAbm0NdOuHH8Qi+Rexi1wLlpzIo1gstHWBfZzy1+qHRV5A4TqPp15YzBPm0WSggW6PbSn+F4lf57VCnHF7p8SvzAA2ZZJPYJURt8X7bbg+H3i+PEjH9DXItNEqs2sNcug37xZQDLm7X36nOoGPs54XsEGzPdEV+itQNGUFEjY6X9Uv+Acuks7NpyGvCoKxGwgKgE5XyJ+nNKlyHHOLb6N1NuHyBrZrgtY/JYJHRooo5CEqYKBqdFnmbTVGEkCvJKxLnjwKWf+fEPoWeQFj5ObDjcKMZf2Jm2Ae69x+ikU5gBXsRmoF94GXTLfN0/vLt98KDPnxwAQL9j5V1jGOY8jQl6MLxEs56cwXN0dqCnImzVH3TZT1cJ8SW1BRX6qIVxEzjsSGx3yxF3suAilPMqGRp4ffyopjMD1JXiKR2RwLKzizUe5e8XyGOy9fplzhw3jVzTRyUZTRSZKkMLWcQ/gv0E4aONNqs4P+NameAZYOD12qRkxosQQP5uux6B2nRyZ7sAV54DgFyLiRcq1FvwKw2EPQdk4HDoePrO/RNUbyNddnM/mMgj4FW65xCoT1LmjrIjsv/Ggdlx46ueczhMgtBunx1/w8k8V+l8LVZ8gAT6wkU5J+DPQalQguMg12Jzug3q4TbdHiGCmD9EunCwOmsLuLJkz6EcSYXtrlDEnAM+hicw7iergYLLlMXpfTdGxJCWJmP4zqUFeTTmsmhsjGBt7NiEB/9pFFEB3pSbf4iiUukw63Eo8Aqnf4iwob6X1QviCWuc8t0LUlT9vALgh/f2DPVOOmR0RW6bgRvc7DSF20V/omg+YBw=='
);


export interface DerivedGroupV2Keys {
  masterKey: Uint8Array;
  secretParams: Uint8Array;
  publicParams: Uint8Array;
  groupIdentifier: Uint8Array;
  internalId: string; // base64(groupIdentifier)
  sendId: string; // 'group.' + internalId
}

export interface GroupV2Metadata {
  id: string;
  internal_id: string;
  masterKey: string;
  revision: number;
  name: string;
  description?: string;
  /** The group photo's CDN key (`Group.avatarUrl`), empty when the group has none; absent on groups saved before 2.9.1. */
  avatar?: string;
  members: string[];
  admins: string[];
  /** Invited users who haven't accepted yet (service IDs). */
  pending: string[];
  /** People who asked to join through the group link and wait for an admin (service IDs). */
  requesting?: string[];
  expireTimer: number;
  blocked: boolean;
  archived?: boolean;
  permissions?: {
    add_members: 'every-member' | 'only-admins';
    edit_group: 'every-member' | 'only-admins';
    send_messages: 'every-member' | 'only-admins';
  };
  link_mode: GroupLinkMode;
  invite_link: string;
  /** Who invited each pending member (`MemberPendingProfileKey.addedByUserId`); dropped once merged into `addedBy`. */
  invitedBy?: Record<string, string>;
  /** Profile sharing is on for the group (Storage Service `GroupV2Record.whitelisted`). */
  whitelisted?: boolean;
  /** Who added or invited us, when we know. */
  addedBy?: string;
  /** Someone we don't know added us, so the group waits as a message request until we answer it. */
  messageRequest?: boolean;
}

export type GroupLinkMode = 'disabled' | 'enabled' | 'enabled-with-approval';

const derivedCache = new Map<string, DerivedGroupV2Keys>();

export function deriveGroupV2Keys(masterKey: Uint8Array): DerivedGroupV2Keys {
  if (masterKey.length !== 32) throw new Error(`Invalid Group V2 masterKey length: ${masterKey.length}`);
  const cacheKey = toBase64(masterKey);
  const cached = derivedCache.get(cacheKey);
  if (cached) return cached;
  const p = libsignal.groupSecretParamsFromMasterKey(masterKey) as {
    secretParams: Uint8Array;
    publicParams: Uint8Array;
    groupIdentifier: Uint8Array;
  };
  const internalId = toBase64(p.groupIdentifier);
  const keys = {
    masterKey,
    secretParams: p.secretParams,
    publicParams: p.publicParams,
    groupIdentifier: p.groupIdentifier,
    internalId,
    sendId: 'group.' + internalId,
  };
  derivedCache.set(cacheKey, keys);
  return keys;
}

/** base64 group identifier (Signal's `groupId`) for a 32-byte master key. */
export function groupIdFromMasterKey(masterKey: Uint8Array): string {
  return deriveGroupV2Keys(masterKey).internalId;
}

export function buildGroupContextV2(groupRecord: { masterKey?: string; revision?: number }): GroupContextV2 | undefined {
  if (!groupRecord.masterKey) return undefined;
  const mk = fromBase64(groupRecord.masterKey);
  if (mk.length !== 32) return undefined;
  return create(GroupContextV2Schema, { masterKey: mk, revision: groupRecord.revision || 0 });
}

export function decryptAttribute(secretParams: Uint8Array, ciphertext: Uint8Array) {
  if (ciphertext.length === 0) return undefined;
  try {
    return fromBinary(GroupAttributeBlobSchema, libsignal.groupDecryptBlob(secretParams, ciphertext)).content;
  } catch {
    return undefined;
  }
}

function startOfUtcDaySeconds(nowMs: number): number {
  return Math.floor(nowMs / 86400000) * 86400;
}

interface StoredGroupCredential {
  redemptionTime: number;
  credential: string;
}

/**
 * Group auth credentials for today, from `GET /v1/certificate/auth/group` (a week at a time, cached in the protocol store).
 */
async function groupCredentialForToday(store: SignalProtocolStore, httpJson: SignalHttpJsonFn, serverUrl: string): Promise<StoredGroupCredential> {
  const today = startOfUtcDaySeconds(Date.now());
  const cached = (await store.loadValue('groupCredentials')) as StoredGroupCredential[] | undefined;
  const hit = Array.isArray(cached) && cached.find((c) => c.redemptionTime === today);
  if (hit) return hit;

  const acc = await store.getAccount();
  if (!acc) throw new Error('This phone is not linked to a Signal account');
  const end = today + 7 * 86400;
  // SECURITY-REVIEW: device password is sent only as Basic auth to the Signal chat server.
  const res = asObject(await httpJson(
    'GET',
    `/v1/certificate/auth/group?redemptionStartSeconds=${today}&redemptionEndSeconds=${end}&v101=true&zkcCredential=true`,
    null,
    { baseUrl: serverUrl, basicAuth: accountBasicAuth(acc), timeout: 15000 }
  ));
  const list: StoredGroupCredential[] = [];
  if (res && Array.isArray(res.credentials)) {
    for (const c of res.credentials) {
      if (c && typeof c.credential === 'string' && typeof c.redemptionTime === 'number') {
        list.push({ credential: c.credential, redemptionTime: c.redemptionTime });
      }
    }
  }
  await store.storeValue('groupCredentials', list);
  const found = list.find((c) => c.redemptionTime === today);
  if (!found) throw new Error('Signal server returned no group credential for today');
  return found;
}

/**
 * Storage server headers for one group: Basic `hex(publicParams):hex(presentation)` with a zkgroup AuthCredentialWithPni presentation.
 */
export async function groupAuthHeaders(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  keys: DerivedGroupV2Keys,
  serverUrl: string,
  serverPublicParams = SERVER_PUBLIC_PARAMS
): Promise<Record<string, string>> {
  const acc = await store.getAccount();
  if (!acc || !acc.pni) throw new Error('Groups need a linked account with a PNI');
  const cred = await groupCredentialForToday(store, httpJson, serverUrl);
  const presentation = libsignal.groupAuthCredentialPresentation(
    serverPublicParams,
    acc.aci,
    acc.pni.replace(/^PNI:/, ''),
    cred.redemptionTime,
    fromBase64(cred.credential),
    keys.secretParams
  );
  const basic = btoa(`${toHex(keys.publicParams)}:${toHex(presentation)}`);
  return { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-protobuf' };
}

/** The current encrypted group from `GET /v2/groups/` on the storage server. */
export async function fetchGroup(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  httpBinary: SignalHttpBinaryFn,
  masterKey: Uint8Array,
  serverUrl: string,
  storageUrl = DEFAULT_STORAGE_SERVER,
  serverPublicParams = SERVER_PUBLIC_PARAMS
): Promise<{ keys: DerivedGroupV2Keys; group: Group; headers: Record<string, string> }> {
  const keys = deriveGroupV2Keys(masterKey);
  const headers = await groupAuthHeaders(store, httpJson, keys, serverUrl, serverPublicParams);
  const bytes = await httpBinary('GET', `${storageUrl}/v2/groups/`, null, headers, 20000);
  const res = fromBinary(GroupResponseSchema, bytes);
  const group = res.group;
  if (!group) throw new Error('Storage server returned no group');
  if (res.groupSendEndorsementsResponse.length) {
    const members = decryptMemberIds(keys, group.members.map((m) => m.userId));
    try {
      await storeGroupSendEndorsements(store, keys.internalId, keys.secretParams, serverPublicParams, res.groupSendEndorsementsResponse, members);
    } catch {
      // Without endorsements, sends to this group go to each member separately.
    }
  }
  return { keys, group, headers };
}

/** `https://signal.group/#…` invite link, built like Signal-Desktop's buildGroupLink. */
export function groupInviteLink(masterKey: Uint8Array, inviteLinkPassword: Uint8Array): string {
  const bytes = toBinary(
    GroupInviteLinkSchema,
    create(GroupInviteLinkSchema, { contents: { case: 'contentsV1', value: { groupMasterKey: masterKey, inviteLinkPassword } } })
  );
  return 'https://signal.group/#' + toWebSafeBase64(bytes);
}

/** The master key and password in a `https://signal.group/#…` link, like Signal-Desktop's parseGroupLink; null for anything else. */
export function parseGroupLink(url: string): { masterKey: Uint8Array; password: Uint8Array } | null {
  const m = /^(?:https:\/\/signal\.group\/|sgnl:\/\/signal\.group\/)#([A-Za-z0-9_-]+={0,2})$/.exec((url || '').trim());
  if (!m) return null;
  try {
    const link = fromBinary(GroupInviteLinkSchema, fromBase64(m[1]));
    if (link.contents.case !== 'contentsV1') return null;
    const { groupMasterKey, inviteLinkPassword } = link.contents.value;
    if (groupMasterKey.length !== 32 || inviteLinkPassword.length === 0) return null;
    return { masterKey: groupMasterKey, password: inviteLinkPassword };
  } catch {
    return null;
  }
}

/** Decrypted service IDs of a member list; entries that fail to decrypt are skipped. */
export function decryptMemberIds(keys: DerivedGroupV2Keys, userIds: Uint8Array[]): string[] {
  const out: string[] = [];
  for (const u of userIds) {
    try {
      out.push(libsignal.groupDecryptServiceId(keys.secretParams, u));
    } catch {
      // not decryptable with this group's keys
    }
  }
  return out;
}

/** Decrypt a group into the record shape the app keeps in `syncedGroups`. */
export function decodeGroupState(keys: DerivedGroupV2Keys, group: Group): GroupV2Metadata {
  const title = decryptAttribute(keys.secretParams, group.title);
  const description = decryptAttribute(keys.secretParams, group.description);
  const timer = decryptAttribute(keys.secretParams, group.disappearingMessagesTimer);

  const members: string[] = [];
  const admins: string[] = [];
  for (const m of group.members) {
    const [id] = decryptMemberIds(keys, [m.userId]);
    if (!id) continue;
    members.push(id);
    if (m.role === Member_Role.ADMINISTRATOR) admins.push(id);
  }
  const pending = decryptMemberIds(
    keys,
    group.membersPendingProfileKey.map((p) => (p.member ? p.member.userId : new Uint8Array(0)))
  );
  const requesting = decryptMemberIds(
    keys,
    group.membersPendingAdminApproval.map((p) => p.userId)
  );
  const invitedBy: Record<string, string> = {};
  for (const p of group.membersPendingProfileKey) {
    const [id] = p.member ? decryptMemberIds(keys, [p.member.userId]) : [];
    const [by] = decryptMemberIds(keys, [p.addedByUserId]);
    if (id && by) invitedBy[id] = by;
  }

  const access = group.accessControl;
  const adminOnly = (v: AccessControl_AccessRequired | undefined) =>
    v === AccessControl_AccessRequired.ADMINISTRATOR ? 'only-admins' : 'every-member';
  const linkAccess = access ? access.addFromInviteLink : AccessControl_AccessRequired.UNSATISFIABLE;
  const linkOn =
    group.inviteLinkPassword.length > 0 &&
    (linkAccess === AccessControl_AccessRequired.ANY || linkAccess === AccessControl_AccessRequired.ADMINISTRATOR);

  return {
    id: keys.sendId,
    internal_id: keys.internalId,
    masterKey: toBase64(keys.masterKey),
    revision: group.version,
    name: title && title.case === 'title' ? title.value : 'Group',
    description: description && description.case === 'descriptionText' ? description.value : '',
    avatar: group.avatarUrl,
    members,
    admins,
    pending,
    requesting,
    expireTimer: timer && timer.case === 'disappearingMessagesDuration' ? timer.value : 0,
    blocked: false,
    permissions: {
      add_members: adminOnly(access && access.members),
      edit_group: adminOnly(access && access.attributes),
      send_messages: group.announcementsOnly ? 'only-admins' : 'every-member',
    },
    link_mode: !linkOn ? 'disabled' : linkAccess === AccessControl_AccessRequired.ADMINISTRATOR ? 'enabled-with-approval' : 'enabled',
    invite_link: linkOn ? groupInviteLink(keys.masterKey, group.inviteLinkPassword) : '',
    invitedBy,
  };
}

/**
 * Fetch and decrypt the current state of a group from `GET /v2/groups` on the storage server.
 */
export async function fetchGroupState(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  httpBinary: SignalHttpBinaryFn,
  masterKey: Uint8Array,
  serverUrl: string,
  storageUrl = DEFAULT_STORAGE_SERVER
): Promise<GroupV2Metadata> {
  const { keys, group } = await fetchGroup(store, httpJson, httpBinary, masterKey, serverUrl, storageUrl);
  return decodeGroupState(keys, group);
}
