/* What this device knows about each group (`syncedGroups`): merging fetched state, and noticing groups and revisions in incoming messages. */

import { fromBase64, toBase64 } from '../bytes';
import { host } from '../host';
import { isAci } from '../net/proto';
import { diffGroupState, groupChangeAuthor, groupIsRequest, isDecodedGroup } from '../services/group-updates';
import { deriveGroupV2Keys, fetchGroupState, type GroupV2Metadata } from '../services/groups-v2';
import { httpBinary, httpJson, serverUrl, store } from './context';
import { saveSyncedGroups, type SyncedGroupRow, syncedContacts, syncedGroups } from './contacts';

/** Who made the change that brought a group to `revision`, and when it arrived. */
export interface GroupChangeHint {
  author: string;
  revision: number;
  timestamp: number;
}

export function groupDeps() {
  return { store, httpJson, httpBinary, serverUrl: serverUrl() };
}

/** Decide once whether a group we just learned about waits as a message request, from who added or invited us. */
async function vetNewGroup(g: SyncedGroupRow, invitedBy: Record<string, string>, hint: GroupChangeHint | undefined): Promise<void> {
  delete g.unvetted;
  const self = host().config.aci() || '';
  const acc = await store.getAccount();
  const pni = acc && acc.pni ? acc.pni.replace(/^PNI:/i, '') : '';
  const addedBy = invitedBy[self] || (pni && (invitedBy['PNI:' + pni] || invitedBy[pni])) || (hint && hint.revision === g.revision ? hint.author : '');
  if (addedBy) g.addedBy = addedBy;
  const adder = addedBy ? (await syncedContacts()).find((c) => c.uuid === addedBy) : undefined;
  if (groupIsRequest(!!g.whitelisted, addedBy, self, adder)) g.messageRequest = true;
}

/** Save a group's new state, and tell the app what changed since the state we had; the change is attributed only when it's the very next revision. */
export async function mergeGroupState(state: GroupV2Metadata, hint?: GroupChangeHint): Promise<void> {
  const list = await syncedGroups();
  const idx = list.findIndex((g) => g.internal_id === state.internal_id);
  const prev = idx >= 0 ? list[idx] : {};
  const merged: SyncedGroupRow = { ...prev, ...state, blocked: prev.blocked ?? false, archived: prev.archived };
  delete merged.invitedBy;
  if (merged.unvetted) await vetNewGroup(merged, state.invitedBy || {}, hint);
  if (idx >= 0) list[idx] = merged;
  else list.push(merged);
  await saveSyncedGroups(list);
  host().directoryChanged().catch(() => {});
  if (!isDecodedGroup(prev) || state.revision <= (prev.revision || 0)) return;
  const author = hint && hint.revision === state.revision && (prev.revision || 0) + 1 === state.revision ? hint.author : '';
  const changes = diffGroupState(prev, state, author, host().config.aci() || '');
  if (changes.length) host().ingest({ envelope: { groupUpdate: { groupId: state.internal_id, author, timestamp: (hint && hint.timestamp) || Date.now(), changes } } });
}

/** Fetch a group's current title, members, and settings from the storage server and merge them into `syncedGroups`. */
export async function refreshGroup(masterKey: Uint8Array, hint?: GroupChangeHint): Promise<void> {
  await mergeGroupState(await fetchGroupState(store, httpJson, httpBinary, masterKey, serverUrl()), hint);
}

export async function resolveGroupRecipients(groupSendId: string): Promise<{ internalId: string; members: string[]; masterKey?: string; revision?: number }> {
  const internalId = groupSendId.replace(/^group\./, '');
  const found = (await syncedGroups()).find((g) => g.id === groupSendId || g.internal_id === internalId);
  const selfAci = host().config.aci();
  const members = ((found && found.members) || []).filter((m: string) => isAci(m) && m !== selfAci);
  return {
    internalId,
    members,
    masterKey: found ? found.masterKey : undefined,
    revision: found ? found.revision : undefined,
  };
}

export async function groupMasterKey(groupSendId: string): Promise<Uint8Array> {
  const grp = await resolveGroupRecipients(groupSendId);
  const mk = grp.masterKey ? fromBase64(grp.masterKey) : new Uint8Array(0);
  if (mk.length !== 32) throw new Error('This group has no Groups V2 master key; legacy groups are not supported');
  return mk;
}

/** Record a group seen in an incoming message; fetch its state when it is new or its revision moved on. */
export async function noteIncomingGroup(masterKey: Uint8Array, revision: number, sender: string, expireTimer: number, groupChange: Uint8Array, timestamp: number): Promise<void> {
  const keys = deriveGroupV2Keys(masterKey);
  const list = await syncedGroups();
  const existing = list.find((g) => g.internal_id === keys.internalId);
  const stale = !existing || (revision || 0) > (existing.revision || 0) || !(existing.members && existing.members.length);
  const fromUs = !!sender && sender === host().config.aci();
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
      unvetted: !fromUs,
    });
    await saveSyncedGroups(list);
  } else if (fromUs && (existing.messageRequest || existing.unvetted)) {
    delete existing.messageRequest;
    delete existing.unvetted;
    await saveSyncedGroups(list);
    host().directoryChanged().catch(() => {});
  }
  if (stale) {
    const author = groupChangeAuthor(keys, groupChange, revision);
    const hint = author && author === sender ? { author, revision, timestamp } : undefined;
    refreshGroup(masterKey, hint).catch((e: any) => host().dbg('group refresh failed: ' + (e && e.message)));
  }
}
