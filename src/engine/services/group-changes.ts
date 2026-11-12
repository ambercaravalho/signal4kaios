/* Groups V2 changes: build GroupChange.Actions, send them with `PATCH /v2/groups/` on the storage server, and return the server-signed change for the GroupContextV2 update members receive. Action shapes follow Signal-Desktop's groups.preload.ts builders (buildAddMember, buildDeleteMemberChange, buildModifyTitleChange, ...). */

import type { MessageInitShape } from '@bufbuild/protobuf';

import { randomBytes, toWebSafeBase64 } from '../bytes';
import {
  AccessControl_AccessRequired,
  Group,
  GroupAttributeBlobSchema,
  GroupJoinInfoSchema,
  GroupChange_Actions_AddMemberActionSchema,
  GroupChange_Actions_AddMemberPendingProfileKeyActionSchema,
  GroupChange_Actions_ModifyMemberRoleActionSchema,
  GroupChange_ActionsSchema,
  GroupChangeResponseSchema,
  GroupChangeSchema,
  Member_Role,
} from '../gen/Groups_pb';
import { libsignal } from '../protocol/libsignal';
import { create, fromBinary, isAci, toBinary } from '../net/proto';
import { DEFAULT_STORAGE_SERVER, SignalHttpBinaryFn, SignalHttpJsonFn } from '../net/http';
import type { SignalProtocolStore } from '../protocol/store';
import type { StorageMutation } from './storage';
import {
  decodeGroupState,
  decryptAttribute,
  decryptMemberIds,
  deriveGroupV2Keys,
  DerivedGroupV2Keys,
  fetchGroup,
  groupAuthHeaders,
  GroupLinkMode,
  GroupV2Metadata,
  SERVER_PUBLIC_PARAMS,
} from './groups-v2';

export type GroupActionsInit = MessageInitShape<typeof GroupChange_ActionsSchema>;
type BlobContent = MessageInitShape<typeof GroupAttributeBlobSchema>['content'];
type AddMemberInit = MessageInitShape<typeof GroupChange_Actions_AddMemberActionSchema>;
type AddPendingInit = MessageInitShape<typeof GroupChange_Actions_AddMemberPendingProfileKeyActionSchema>;
type RoleInit = MessageInitShape<typeof GroupChange_Actions_ModifyMemberRoleActionSchema>;
type DeleteInit = { deletedUserId: Uint8Array };

/** A failed group change; `name` is the code the UI branches on. */
export class GroupChangeError extends Error {
  constructor(code: 'GroupChangeForbidden' | 'GroupChangeConflict' | 'LastAdmin' | 'NotAMember' | 'GroupLinkInvalid', message: string) {
    super(message);
    this.name = code;
  }
}

export interface GroupChangeDeps {
  store: SignalProtocolStore;
  httpJson: SignalHttpJsonFn;
  httpBinary: SignalHttpBinaryFn;
  serverUrl: string;
  storageUrl?: string;
  serverPublicParams?: Uint8Array;
}

/** The group as the server holds it, with members' encrypted user IDs keyed by service ID (the server matches them byte for byte). */
export interface GroupSnapshot {
  keys: DerivedGroupV2Keys;
  group: Group;
  selfAci: string;
  members: Map<string, Uint8Array>;
  pending: Map<string, Uint8Array>;
  requesting: Map<string, Uint8Array>;
  admins: Set<string>;
}

export interface GroupChangeResult {
  /** Serialized server-signed GroupChange for `GroupContextV2.groupChange`. */
  groupChange: Uint8Array;
  revision: number;
  state: GroupV2Metadata;
  /** ACIs to send the update to: everyone in the group before or after the change, except us. */
  notify: string[];
}

function cipherMap(keys: DerivedGroupV2Keys, userIds: Uint8Array[]): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const u of userIds) {
    const [id] = decryptMemberIds(keys, [u]);
    if (id) out.set(id, u);
  }
  return out;
}

export function snapshotGroup(keys: DerivedGroupV2Keys, group: Group, selfAci: string): GroupSnapshot {
  const admins = new Set<string>();
  for (const m of group.members) {
    if (m.role !== Member_Role.ADMINISTRATOR) continue;
    const [id] = decryptMemberIds(keys, [m.userId]);
    if (id) admins.add(id);
  }
  return {
    keys,
    group,
    selfAci,
    members: cipherMap(keys, group.members.map((m) => m.userId)),
    pending: cipherMap(keys, group.membersPendingProfileKey.map((p) => (p.member ? p.member.userId : new Uint8Array(0)))),
    requesting: cipherMap(keys, group.membersPendingAdminApproval.map((p) => p.userId)),
    admins,
  };
}

function everyone(state: { members: string[]; pending: string[] }): string[] {
  return state.members.concat(state.pending);
}

/**
 * Fetch the group, build actions against it, and apply them at revision+1. On a 409 (someone else changed the group first) the state is re-fetched and the actions rebuilt once. `build` returns null when there is nothing to change.
 */
export async function applyGroupChange(
  deps: GroupChangeDeps,
  masterKey: Uint8Array,
  build: (snap: GroupSnapshot) => GroupActionsInit | null | Promise<GroupActionsInit | null>
): Promise<GroupChangeResult | null> {
  const storageUrl = deps.storageUrl || DEFAULT_STORAGE_SERVER;
  const params = deps.serverPublicParams || SERVER_PUBLIC_PARAMS;
  const acc = await deps.store.getAccount();
  if (!acc) throw new Error('This phone is not linked to a Signal account');

  for (let attempt = 0; ; attempt++) {
    const { keys, group, headers } = await fetchGroup(deps.store, deps.httpJson, deps.httpBinary, masterKey, deps.serverUrl, storageUrl, params);
    const snap = snapshotGroup(keys, group, acc.aci);
    const init = await build(snap);
    if (!init) return null;
    const actions = create(GroupChange_ActionsSchema, { ...init, version: group.version + 1 });

    let bytes: Uint8Array;
    try {
      bytes = await deps.httpBinary('PATCH', `${storageUrl}/v2/groups/`, toBinary(GroupChange_ActionsSchema, actions), headers, 20000);
    } catch (err: any) {
      const status = err && err.status;
      if (status === 409 && attempt === 0) continue;
      if (status === 409) throw new GroupChangeError('GroupChangeConflict', 'The group changed on another device; try again');
      if (status === 403) throw new GroupChangeError('GroupChangeForbidden', "You don't have permission to make this change");
      throw err;
    }
    const signed = fromBinary(GroupChangeResponseSchema, bytes).groupChange;
    if (!signed || signed.actions.length === 0) throw new Error('Storage server returned no group change');
    const applied = fromBinary(GroupChange_ActionsSchema, signed.actions);
    if (applied.version !== group.version + 1) throw new Error('Storage server returned a group change for the wrong revision');

    const before = decodeGroupState(keys, group);
    let state: GroupV2Metadata;
    try {
      const after = await fetchGroup(deps.store, deps.httpJson, deps.httpBinary, masterKey, deps.serverUrl, storageUrl, params);
      state = decodeGroupState(after.keys, after.group);
    } catch (err: any) {
      // After leaving, the server no longer shows us the group.
      if (!err || err.status !== 403) throw err;
      const gone = (ids: string[]) => ids.filter((id) => id !== acc.aci);
      state = { ...before, revision: applied.version, members: gone(before.members), admins: gone(before.admins), pending: gone(before.pending) };
    }
    const notify = Array.from(new Set(everyone(before).concat(everyone(state)))).filter((id) => isAci(id) && id !== acc.aci);
    return { groupChange: toBinary(GroupChangeSchema, signed), revision: applied.version, state, notify };
  }
}

function encryptBlob(snap: GroupSnapshot, content: BlobContent): Uint8Array {
  const plain = toBinary(GroupAttributeBlobSchema, create(GroupAttributeBlobSchema, { content }));
  return libsignal.groupEncryptBlob(snap.keys.secretParams, plain, 0);
}

function encryptUserId(snap: GroupSnapshot, serviceId: string): Uint8Array {
  return snap.members.get(serviceId) || snap.pending.get(serviceId) || snap.requesting.get(serviceId) || libsignal.groupEncryptServiceId(snap.keys.secretParams, serviceId);
}

export function titleActions(snap: GroupSnapshot, title: string): GroupActionsInit {
  return { modifyTitle: { title: encryptBlob(snap, { case: 'title', value: title }) } };
}

export function descriptionActions(snap: GroupSnapshot, description: string): GroupActionsInit {
  return { modifyDescription: { description: encryptBlob(snap, { case: 'descriptionText', value: description }) } };
}

export function timerActions(snap: GroupSnapshot, seconds: number): GroupActionsInit {
  return { modifyDisappearingMessageTimer: { timer: encryptBlob(snap, { case: 'disappearingMessagesDuration', value: Math.max(0, Math.floor(seconds)) }) } };
}

type Who = 'every-member' | 'only-admins';
const access = (w: Who) => (w === 'only-admins' ? AccessControl_AccessRequired.ADMINISTRATOR : AccessControl_AccessRequired.MEMBER);

/** Permission changes; only values that differ from the current group are sent. */
export function permissionActions(
  snap: GroupSnapshot,
  perms: { add_members?: Who; edit_group?: Who; send_messages?: Who }
): GroupActionsInit | null {
  const cur = snap.group.accessControl;
  const out: GroupActionsInit = {};
  if (perms.add_members && (!cur || cur.members !== access(perms.add_members))) {
    out.modifyMemberAccess = { membersAccess: access(perms.add_members) };
  }
  if (perms.edit_group && (!cur || cur.attributes !== access(perms.edit_group))) {
    out.modifyAttributesAccess = { attributesAccess: access(perms.edit_group) };
  }
  if (perms.send_messages && snap.group.announcementsOnly !== (perms.send_messages === 'only-admins')) {
    out.modifyAnnouncementsOnly = { announcementsOnly: perms.send_messages === 'only-admins' };
  }
  return Object.keys(out).length ? out : null;
}

/** Group link on/off/approval like Signal-Desktop: turning it on the first time (or resetting it) also sets a new 16-byte invite password. */
export function inviteLinkActions(snap: GroupSnapshot, mode: GroupLinkMode, reset = false): GroupActionsInit | null {
  const required =
    mode === 'enabled'
      ? AccessControl_AccessRequired.ANY
      : mode === 'enabled-with-approval'
        ? AccessControl_AccessRequired.ADMINISTRATOR
        : AccessControl_AccessRequired.UNSATISFIABLE;
  const out: GroupActionsInit = {};
  const cur = snap.group.accessControl;
  if (!cur || cur.addFromInviteLink !== required) out.modifyAddFromInviteLinkAccess = { addFromInviteLinkAccess: required };
  if (mode !== 'disabled' && (reset || snap.group.inviteLinkPassword.length === 0)) {
    out.modifyInviteLinkPassword = { inviteLinkPassword: randomBytes(16) };
  }
  return Object.keys(out).length ? out : null;
}

/** Adds members: with a profile key credential presentation they join directly, otherwise they are invited (pending profile key). */
export function addMembersActions(snap: GroupSnapshot, adds: Array<{ aci: string; presentation?: Uint8Array }>): GroupActionsInit | null {
  const addMembers: AddMemberInit[] = [];
  const addMembersPendingProfileKey: AddPendingInit[] = [];
  for (const a of adds) {
    if (!isAci(a.aci) || snap.members.has(a.aci) || snap.pending.has(a.aci)) continue;
    if (a.presentation) {
      addMembers.push({ added: { presentation: a.presentation, role: Member_Role.DEFAULT } });
    } else {
      addMembersPendingProfileKey.push({ added: { member: { userId: encryptUserId(snap, a.aci), role: Member_Role.DEFAULT } } });
    }
  }
  if (!addMembers.length && !addMembersPendingProfileKey.length) return null;
  return { addMembers, addMembersPendingProfileKey };
}

/** Removes members, cancels invites, and denies join requests. */
export function removeMembersActions(snap: GroupSnapshot, ids: string[]): GroupActionsInit | null {
  const deleteMembers: DeleteInit[] = [];
  const deleteMembersPendingProfileKey: DeleteInit[] = [];
  const deleteMembersPendingAdminApproval: DeleteInit[] = [];
  for (const id of ids) {
    const m = snap.members.get(id);
    const p = snap.pending.get(id);
    const r = snap.requesting.get(id);
    if (m) deleteMembers.push({ deletedUserId: m });
    else if (p) deleteMembersPendingProfileKey.push({ deletedUserId: p });
    else if (r) deleteMembersPendingAdminApproval.push({ deletedUserId: r });
  }
  if (!deleteMembers.length && !deleteMembersPendingProfileKey.length && !deleteMembersPendingAdminApproval.length) return null;
  return { deleteMembers, deleteMembersPendingProfileKey, deleteMembersPendingAdminApproval };
}

/** Approves join requests, as Signal-Desktop's buildPromotePendingAdminApprovalMemberChange: they join as regular members. */
export function approveRequestsActions(snap: GroupSnapshot, ids: string[]): GroupActionsInit | null {
  const promoteMembersPendingAdminApproval: Array<{ userId: Uint8Array; role: Member_Role }> = [];
  for (const id of ids) {
    const userId = snap.requesting.get(id);
    if (userId) promoteMembersPendingAdminApproval.push({ userId, role: Member_Role.DEFAULT });
  }
  return promoteMembersPendingAdminApproval.length ? { promoteMembersPendingAdminApproval } : null;
}

/** Accept our invite with our profile key credential, as Signal-Desktop's buildPromoteMemberChange; an invite to our phone number promotes the PNI entry. Null when we're already a member. */
export function acceptInviteActions(snap: GroupSnapshot, presentation: Uint8Array, selfPni: string): GroupActionsInit | null {
  if (snap.members.has(snap.selfAci)) return null;
  if (snap.pending.has(snap.selfAci)) return { promoteMembersPendingProfileKey: [{ presentation }] };
  const pni = selfPni.replace(/^PNI:/i, '');
  if (pni && (snap.pending.has('PNI:' + pni) || snap.pending.has(pni))) return { promoteMembersPendingPniAciProfileKey: [{ presentation }] };
  throw new GroupChangeError('NotAMember', 'You are not invited to this group');
}

export function roleActions(snap: GroupSnapshot, ids: string[], admin: boolean): GroupActionsInit | null {
  const modifyMemberRoles: RoleInit[] = [];
  for (const id of ids) {
    const userId = snap.members.get(id);
    if (!userId || snap.admins.has(id) === admin) continue;
    modifyMemberRoles.push({ userId, role: admin ? Member_Role.ADMINISTRATOR : Member_Role.DEFAULT });
  }
  return modifyMemberRoles.length ? { modifyMemberRoles } : null;
}

/** What a group link shows before joining, from `GET /v2/groups/join/{password}` (Signal-Desktop's getGroupFromLink). */
export interface GroupJoinInfoView {
  title: string;
  description: string;
  memberCount: number;
  revision: number;
  /** An admin has to approve the request. */
  approvalRequired: boolean;
  /** We already asked to join and wait for an admin. */
  pending: boolean;
}

function linkQuery(password?: Uint8Array): string {
  return password && password.length ? '?inviteLinkPassword=' + toWebSafeBase64(password) : '';
}

function linkError(err: any): never {
  const status = err && err.status;
  if (status === 403 || status === 404 || status === 423) throw new GroupChangeError('GroupLinkInvalid', 'This group link is no longer valid');
  throw err;
}

/** Join info for a link. Without a password it only works while our own join request is pending. */
export async function fetchGroupJoinInfo(deps: GroupChangeDeps, masterKey: Uint8Array, password?: Uint8Array): Promise<GroupJoinInfoView> {
  const storageUrl = deps.storageUrl || DEFAULT_STORAGE_SERVER;
  const keys = deriveGroupV2Keys(masterKey);
  const headers = await groupAuthHeaders(deps.store, deps.httpJson, keys, deps.serverUrl, deps.serverPublicParams || SERVER_PUBLIC_PARAMS);
  const path = `${storageUrl}/v2/groups/join/${password && password.length ? toWebSafeBase64(password) : ''}`;
  const bytes = await deps.httpBinary('GET', path, null, headers, 20000).catch(linkError);
  const info = fromBinary(GroupJoinInfoSchema, bytes);
  const access = info.addFromInviteLink;
  if (!info.pendingAdminApproval && access !== AccessControl_AccessRequired.ANY && access !== AccessControl_AccessRequired.ADMINISTRATOR) {
    throw new GroupChangeError('GroupLinkInvalid', 'This group link is no longer valid');
  }
  const title = decryptAttribute(keys.secretParams, info.title);
  const description = decryptAttribute(keys.secretParams, info.description);
  return {
    title: title && title.case === 'title' ? title.value : '',
    description: description && description.case === 'descriptionText' ? description.value : '',
    memberCount: info.memberCount,
    revision: info.version,
    approvalRequired: access === AccessControl_AccessRequired.ADMINISTRATOR,
    pending: info.pendingAdminApproval,
  };
}

export interface GroupLinkJoinResult {
  /** Serialized server-signed GroupChange, or empty when our request was already pending. */
  groupChange: Uint8Array;
  revision: number;
  /** True when we are now a member; false when we wait for an admin. */
  joined: boolean;
}

async function patchViaLink(deps: GroupChangeDeps, masterKey: Uint8Array, password: Uint8Array | undefined, init: GroupActionsInit, revision: number): Promise<Uint8Array> {
  const storageUrl = deps.storageUrl || DEFAULT_STORAGE_SERVER;
  const keys = deriveGroupV2Keys(masterKey);
  const headers = await groupAuthHeaders(deps.store, deps.httpJson, keys, deps.serverUrl, deps.serverPublicParams || SERVER_PUBLIC_PARAMS);
  const actions = create(GroupChange_ActionsSchema, { ...init, version: revision + 1 });
  const bytes = await deps.httpBinary('PATCH', `${storageUrl}/v2/groups/${linkQuery(password)}`, toBinary(GroupChange_ActionsSchema, actions), headers, 20000);
  const signed = fromBinary(GroupChangeResponseSchema, bytes).groupChange;
  if (!signed || signed.actions.length === 0) throw new Error('Storage server returned no group change');
  const applied = fromBinary(GroupChange_ActionsSchema, signed.actions);
  if (applied.version !== revision + 1) throw new Error('Storage server returned a group change for the wrong revision');
  return toBinary(GroupChangeSchema, signed);
}

/**
 * Join through a group link with our own profile key credential presentation, as Signal-Desktop's joinViaLink: straight in (addMembers) when the link needs no approval, otherwise a request an admin approves (addMembersPendingAdminApproval). A 409 re-reads the join info and retries once.
 */
export async function joinGroupViaLink(deps: GroupChangeDeps, masterKey: Uint8Array, password: Uint8Array, presentation: Uint8Array): Promise<GroupLinkJoinResult> {
  for (let attempt = 0; ; attempt++) {
    const info = await fetchGroupJoinInfo(deps, masterKey, password);
    if (info.pending) return { groupChange: new Uint8Array(0), revision: info.revision, joined: false };
    const init: GroupActionsInit = info.approvalRequired
      ? { addMembersPendingAdminApproval: [{ added: { presentation } }] }
      : { addMembers: [{ added: { presentation, role: Member_Role.DEFAULT } }] };
    try {
      const groupChange = await patchViaLink(deps, masterKey, password, init, info.revision);
      return { groupChange, revision: info.revision + 1, joined: !info.approvalRequired };
    } catch (err: any) {
      const status = err && err.status;
      if ((status === 409 || status === 400) && attempt === 0) continue;
      if (status === 409) throw new GroupChangeError('GroupChangeConflict', 'The group changed while joining; try again');
      linkError(err);
    }
  }
}

/** The Storage Service record for a group we joined, so our other devices list it; the record is created when missing. */
export function joinedGroupMutation(masterKey: Uint8Array): StorageMutation {
  return { type: 'groupV2', masterKey, update: (g) => { g.whitelisted = true; } };
}

/** Withdraw our pending join request (deleteMembersPendingAdminApproval for ourselves). */
export async function cancelGroupJoinRequest(deps: GroupChangeDeps, masterKey: Uint8Array, password?: Uint8Array): Promise<number> {
  const acc = await deps.store.getAccount();
  if (!acc) throw new Error('This phone is not linked to a Signal account');
  const keys = deriveGroupV2Keys(masterKey);
  for (let attempt = 0; ; attempt++) {
    const info = await fetchGroupJoinInfo(deps, masterKey, password);
    if (!info.pending) return info.revision;
    const init: GroupActionsInit = { deleteMembersPendingAdminApproval: [{ deletedUserId: libsignal.groupEncryptServiceId(keys.secretParams, acc.aci) }] };
    try {
      await patchViaLink(deps, masterKey, password, init, info.revision);
      return info.revision + 1;
    } catch (err: any) {
      if (err && err.status === 409 && attempt === 0) continue;
      linkError(err);
    }
  }
}

/** Leave the group, decline an invite, or cancel a join request. The last admin has to promote someone first, as in Signal-Desktop. */
export function leaveActions(snap: GroupSnapshot): GroupActionsInit {
  const self = snap.selfAci;
  if (snap.members.has(self)) {
    const otherMembers = Array.from(snap.members.keys()).filter((id) => id !== self);
    const otherAdmins = Array.from(snap.admins).filter((id) => id !== self);
    if (snap.admins.has(self) && otherAdmins.length === 0 && otherMembers.length > 0) {
      throw new GroupChangeError('LastAdmin', 'Make another member an admin before leaving');
    }
  }
  const out = removeMembersActions(snap, [self]);
  if (!out) throw new GroupChangeError('NotAMember', 'You are not a member of this group');
  return out;
}
