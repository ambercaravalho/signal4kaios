/* Lines for a chat about what changed in a group, from the difference between two decrypted group states. Wording and cases follow Signal-Desktop's groupChange.std.ts; the author comes from the signed change when it's known. */

import { fromBinary } from '../net/proto';
import { GroupChange_ActionsSchema, GroupChangeSchema } from '../gen/Groups_pb';
import { decryptMemberIds, type DerivedGroupV2Keys, type GroupV2Metadata } from './groups-v2';

export type GroupUpdateKind =
  | 'title'
  | 'description'
  | 'timer'
  | 'permAddMembers'
  | 'permEditGroup'
  | 'permSend'
  | 'link'
  | 'linkReset'
  | 'memberAdded'
  | 'joinedViaLink'
  | 'inviteAccepted'
  | 'requestApproved'
  | 'memberRemoved'
  | 'left'
  | 'adminAdded'
  | 'adminRemoved'
  | 'invited'
  | 'inviteRemoved'
  | 'inviteDeclined'
  | 'requested'
  | 'requestDenied';

/** One change. `target` is the person it's about (a service ID); `value` is a permission or link mode, and `from` the link mode before; `count` is how many people were invited or uninvited. */
export interface GroupUpdate {
  change: GroupUpdateKind;
  target?: string;
  text?: string;
  seconds?: number;
  value?: string;
  from?: string;
  count?: number;
}

const MAX_UPDATES = 50;

function minus(a: string[] | undefined, b: string[] | undefined): string[] {
  const drop = new Set(b || []);
  return (a || []).filter((x) => !drop.has(x));
}

/** True for a group record decoded from the server (not the placeholder kept until the first fetch). */
export function isDecodedGroup(g: any): g is GroupV2Metadata {
  return !!g && Array.isArray(g.members) && g.members.length > 0 && Array.isArray(g.pending) && typeof g.link_mode === 'string';
}

/**
 * What changed from `prev` to `next`. `author` is who made the change, or '' when it isn't known (several revisions at once, or no signed change). Invites to other people are counted rather than named, as in Signal.
 */
export function diffGroupState(prev: GroupV2Metadata, next: GroupV2Metadata, author: string, selfAci: string): GroupUpdate[] {
  const out: GroupUpdate[] = [];
  if (prev.name !== next.name) out.push({ change: 'title', text: next.name });
  if ((prev.description || '') !== (next.description || '')) out.push({ change: 'description' });
  if ((prev.expireTimer || 0) !== (next.expireTimer || 0)) out.push({ change: 'timer', seconds: next.expireTimer || 0 });

  const pp = prev.permissions;
  const np = next.permissions;
  if (pp && np) {
    if (pp.add_members !== np.add_members) out.push({ change: 'permAddMembers', value: np.add_members });
    if (pp.edit_group !== np.edit_group) out.push({ change: 'permEditGroup', value: np.edit_group });
    if (pp.send_messages !== np.send_messages) out.push({ change: 'permSend', value: np.send_messages });
  }
  if (prev.link_mode !== next.link_mode) out.push({ change: 'link', value: next.link_mode, from: prev.link_mode });
  else if (next.link_mode !== 'disabled' && prev.invite_link && next.invite_link && prev.invite_link !== next.invite_link) out.push({ change: 'linkReset' });

  for (const id of minus(next.members, prev.members)) {
    if ((prev.requesting || []).indexOf(id) >= 0) out.push({ change: 'requestApproved', target: id });
    else if (prev.pending.indexOf(id) >= 0) out.push({ change: 'inviteAccepted', target: id });
    else if (author && author === id) out.push({ change: 'joinedViaLink', target: id });
    else out.push({ change: 'memberAdded', target: id });
  }
  for (const id of minus(prev.members, next.members)) out.push({ change: author && author === id ? 'left' : 'memberRemoved', target: id });

  for (const id of minus(next.admins, prev.admins)) if (next.members.indexOf(id) >= 0) out.push({ change: 'adminAdded', target: id });
  for (const id of minus(prev.admins, next.admins)) if (next.members.indexOf(id) >= 0) out.push({ change: 'adminRemoved', target: id });

  const invited = minus(next.pending, prev.pending);
  if (invited.indexOf(selfAci) >= 0) out.push({ change: 'invited', target: selfAci, count: 1 });
  const othersInvited = invited.filter((id) => id !== selfAci).length;
  if (othersInvited) out.push({ change: 'invited', count: othersInvited });
  const uninvited = minus(minus(prev.pending, next.pending), next.members).filter((id) => id !== selfAci);
  if (author && uninvited.indexOf(author) >= 0) out.push({ change: 'inviteDeclined', target: author });
  const revoked = uninvited.filter((id) => id !== author).length;
  if (revoked) out.push({ change: 'inviteRemoved', count: revoked });

  for (const id of minus(next.requesting, prev.requesting)) out.push({ change: 'requested', target: id });
  for (const id of minus(minus(prev.requesting, next.requesting), next.members)) out.push({ change: 'requestDenied', target: id });

  return out.slice(0, MAX_UPDATES);
}

/** Signal-Desktop's isFromOrAddedByTrustedContact for a group: a message request unless profile sharing is on, or whoever added us is us, a system contact, or someone whose request we accepted. */
export function groupIsRequest(whitelisted: boolean, addedBy: string, selfAci: string, adder: { whitelisted?: boolean; systemContact?: boolean } | undefined): boolean {
  if (whitelisted || (!!addedBy && addedBy === selfAci)) return false;
  return !adder || (!adder.whitelisted && !adder.systemContact);
}

/** The service ID that made a signed group change, when the change is for `revision`. */
export function groupChangeAuthor(keys: DerivedGroupV2Keys, groupChange: Uint8Array, revision: number): string {
  if (!groupChange.length) return '';
  try {
    const actions = fromBinary(GroupChange_ActionsSchema, fromBinary(GroupChangeSchema, groupChange).actions);
    if (actions.version !== revision || !actions.sourceUserId.length) return '';
    return decryptMemberIds(keys, [actions.sourceUserId])[0] || '';
  } catch {
    return '';
  }
}
