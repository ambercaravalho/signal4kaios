/* Changing groups: settings, members, admins, group links, leaving, and blocking. */

import { ContentSchema, SyncMessage_MessageRequestResponse_Type } from '../gen/SignalService_pb';
import { host } from '../host';
import { create, isAci } from '../net/proto';
import {
  acceptInviteActions,
  addMembersActions,
  applyGroupChange,
  approveRequestsActions,
  cancelGroupJoinRequest,
  descriptionActions,
  fetchGroupJoinInfo,
  type GroupActionsInit,
  GroupChangeError,
  type GroupJoinInfoView,
  type GroupSnapshot,
  inviteLinkActions,
  joinedGroupMutation,
  joinGroupViaLink,
  leaveActions,
  permissionActions,
  removeMembersActions,
  roleActions,
  timerActions,
  titleActions,
} from '../services/group-changes';
import { deriveGroupV2Keys, fetchGroupState, type GroupLinkMode, type GroupV2Metadata, parseGroupLink, SERVER_PUBLIC_PARAMS } from '../services/groups-v2';
import { fetchExpiringProfileKeyCredential, resolveSignalUsername } from '../services/profiles';
import { libsignal } from '../protocol/libsignal';
import { fromBase64 } from '../bytes';
import { invalidateBlocked, sendBlockedSync } from './blocked';
import { client, httpBinary, httpJson, serverUrl, storageQueue, store } from './context';
import { resolveAci, syncedContacts, syncedGroups, updateSyncedGroup } from './contacts';
import { dataContent, type DataMessageInit, syncSent } from './delivery';
import { groupDeps, groupMasterKey, mergeGroupState } from './group-state';

export type GroupLinkPreview = GroupJoinInfoView & { internalId: string; member: boolean };

type GroupPermission = 'every-member' | 'only-admins';

/** Tell `notify` about a group change we made (GroupContextV2 with `groupChange`, as Signal-Desktop's sendGroupUpdate does) and our other devices. */
async function announceGroupChange(notify: string[], masterKey: Uint8Array, revision: number, groupChange: Uint8Array | undefined, profileKey: Uint8Array | undefined, ts: number): Promise<void> {
  const dm: DataMessageInit = { timestamp: BigInt(ts), profileKey, groupV2: { masterKey, revision, groupChange } };
  await client.sendGroupContent(notify, dataContent(dm), ts).catch((e: any) => host().dbg('group update send failed: ' + (e && e.message)));
  await client.sendSyncMessage(syncSent('', ts, dm), ts);
}

/** Apply a Groups V2 change on the storage server, then send the signed change to everyone affected and to our other devices. Resolves to the new group state, or null when nothing changed. */
async function changeGroup(groupSendId: string, build: (snap: GroupSnapshot) => GroupActionsInit | null | Promise<GroupActionsInit | null>): Promise<GroupV2Metadata | null> {
  const masterKey = await groupMasterKey(groupSendId);
  const res = await applyGroupChange(groupDeps(), masterKey, build);
  if (!res) return null;
  const acc = await store.getAccount();
  const ts = Date.now();
  await mergeGroupState(res.state, { author: acc ? acc.aci : '', revision: res.revision, timestamp: ts });
  await announceGroupChange(res.notify, masterKey, res.revision, res.groupChange, acc ? acc.profileKey : undefined, ts);
  return res.state;
}

function requireLink(url: string) {
  const link = parseGroupLink(url);
  if (!link) throw new GroupChangeError('GroupLinkInvalid', 'This is not a group link');
  return link;
}

async function resolveAll(ids: string[]): Promise<string[]> {
  return Promise.all(ids.map(async (id) => (await resolveAci(id)) || id));
}

export const groupMethods = {
  /** Change a group's name, description, disappearing-message timer, permissions, or group link on the storage server and notify its members. */
  async updateGroup(
    groupSendId: string,
    body: {
      name?: string;
      description?: string;
      expiration_time?: number;
      permissions?: { add_members?: GroupPermission; edit_group?: GroupPermission; send_messages?: GroupPermission };
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
    const contacts = await syncedContacts();
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
    const resolved = await resolveAll(ids);
    return changeGroup(groupSendId, (snap) => removeMembersActions(snap, resolved));
  },

  /** Let people who asked to join through the group link in; deny a request with `removeGroupMembers`. */
  async approveGroupRequests(groupSendId: string, ids: string[]): Promise<GroupV2Metadata | null> {
    return changeGroup(groupSendId, (snap) => approveRequestsActions(snap, ids));
  },

  /** What a signal.group link leads to: the group's name, size, and whether joining needs an admin, or `member` when we are already in it. */
  async groupLinkInfo(url: string): Promise<GroupLinkPreview> {
    const link = requireLink(url);
    const keys = deriveGroupV2Keys(link.masterKey);
    const known = (await syncedGroups()).find((g) => g.internal_id === keys.internalId);
    const self = host().config.aci() || '';
    if (known && Array.isArray(known.members) && known.members.includes(self)) {
      return { internalId: keys.internalId, title: known.name || '', description: known.description || '', memberCount: known.members.length, revision: known.revision || 0, approvalRequired: false, pending: false, member: true };
    }
    const info = await fetchGroupJoinInfo(groupDeps(), link.masterKey, link.password);
    return { ...info, internalId: keys.internalId, member: false };
  },

  /** Join through a signal.group link, or ask to join when the group needs an admin's approval. */
  async joinGroupLink(url: string): Promise<{ joined: boolean; internalId: string; name: string }> {
    const link = requireLink(url);
    const acc = await store.getAccount();
    if (!acc || !acc.profileKey) throw new Error('This phone is not linked to a Signal account');
    const keys = deriveGroupV2Keys(link.masterKey);
    const cred = await fetchExpiringProfileKeyCredential(store, httpJson, SERVER_PUBLIC_PARAMS, acc.aci, acc.profileKey, serverUrl());
    const presentation = libsignal.groupProfileKeyCredentialPresentation(SERVER_PUBLIC_PARAMS, keys.secretParams, cred);
    const res = await joinGroupViaLink(groupDeps(), link.masterKey, link.password, presentation);
    if (!res.joined) return { joined: false, internalId: keys.internalId, name: '' };

    const state = await fetchGroupState(store, httpJson, httpBinary, link.masterKey, serverUrl());
    await mergeGroupState(state);
    await storageQueue.enqueue([joinedGroupMutation(link.masterKey)]).catch((e: any) => host().dbg('group storage record failed: ' + (e && e.message)));
    const notify = state.members.concat(state.pending).filter((id) => isAci(id) && id !== acc.aci);
    await announceGroupChange(notify, link.masterKey, res.revision, res.groupChange, acc.profileKey, Date.now());
    return { joined: true, internalId: keys.internalId, name: state.name };
  },

  /** Withdraw a request to join made through a group link. */
  async cancelGroupLinkRequest(url: string): Promise<void> {
    const link = requireLink(url);
    await cancelGroupJoinRequest(groupDeps(), link.masterKey, link.password);
  },

  async setGroupAdmins(groupSendId: string, ids: string[], admin: boolean): Promise<GroupV2Metadata | null> {
    const resolved = await resolveAll(ids);
    return changeGroup(groupSendId, (snap) => roleActions(snap, resolved, admin));
  },

  /** Leave a group, decline its invite, or cancel a join request. */
  async leaveGroup(groupSendId: string): Promise<void> {
    await changeGroup(groupSendId, (snap) => leaveActions(snap));
  },

  /**
   * Answer a group message request like Signal-Desktop: accepting joins through a pending invite and turns on profile sharing; deleting leaves; blocking leaves and blocks. Our other devices hear about it through the MessageRequestResponse sync.
   */
  async answerGroupRequest(groupSendId: string, response: 'accept' | 'delete' | 'block'): Promise<void> {
    const masterKey = await groupMasterKey(groupSendId);
    const internalId = deriveGroupV2Keys(masterKey).internalId;
    if (response === 'accept') {
      const acc = await store.getAccount();
      if (!acc || !acc.profileKey) throw new Error('This phone is not linked to a Signal account');
      const group = (await syncedGroups()).find((g) => g.internal_id === internalId);
      if (group && !(group.members || []).includes(acc.aci)) {
        const cred = await fetchExpiringProfileKeyCredential(store, httpJson, SERVER_PUBLIC_PARAMS, acc.aci, acc.profileKey, serverUrl());
        await changeGroup(groupSendId, (snap) => acceptInviteActions(snap, libsignal.groupProfileKeyCredentialPresentation(SERVER_PUBLIC_PARAMS, snap.keys.secretParams, cred), acc.pni || ''));
      }
      await updateSyncedGroup(internalId, (g) => {
        g.whitelisted = true;
        delete g.messageRequest;
      });
      await storageQueue.enqueue([joinedGroupMutation(masterKey)]).catch((e: any) => host().dbg('group storage record failed: ' + (e && e.message)));
    } else if (response === 'block') {
      await groupMethods.setGroupBlocked(groupSendId, true);
    } else {
      await changeGroup(groupSendId, (snap) => leaveActions(snap)).catch((e: any) => {
        if (!e || (e.name !== 'NotAMember' && e.status !== 403)) throw e;
      });
    }
    const type = { accept: SyncMessage_MessageRequestResponse_Type.ACCEPT, delete: SyncMessage_MessageRequestResponse_Type.DELETE, block: SyncMessage_MessageRequestResponse_Type.BLOCK }[response];
    await client.sendSyncMessage(create(ContentSchema, { content: { case: 'syncMessage', value: { content: { case: 'messageRequestResponse', value: { groupId: fromBase64(internalId), type } } } } }));
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
};
