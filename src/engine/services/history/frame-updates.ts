/* A link-and-sync archive's chat updates (calls, timers, safety numbers, payments, group changes) to the notices the app shows, following Signal-Desktop's backups/import. Updates Beacon has no line for are dropped. */

import {
  type ChatUpdateMessage,
  type GroupChangeChatUpdate_Update,
  GroupV2AccessLevel,
  IndividualCall_Type,
  SimpleChatUpdate_Type,
} from '../../gen/Backups_pb';
import { uuidOf } from './frame-content';
import type { HistoryGroupUpdate, HistoryMessage } from './types';

const MAX_GROUP_UPDATES = 50;
const MAX_TEXT = 300;

function access(level: GroupV2AccessLevel): string {
  return level === GroupV2AccessLevel.ADMINISTRATOR ? 'only-admins' : 'every-member';
}

/** One group change, and who made it ('' when the archive doesn't say). */
function groupChange(u: GroupChangeChatUpdate_Update['update']): [HistoryGroupUpdate | null, string] {
  switch (u.case) {
    case 'groupNameUpdate': return [{ change: 'title', text: (u.value.newGroupName || '').slice(0, MAX_TEXT) }, uuidOf(u.value.updaterAci)];
    case 'groupDescriptionUpdate': return [{ change: 'description' }, uuidOf(u.value.updaterAci)];
    case 'groupExpirationTimerUpdate': return [{ change: 'timer', seconds: Math.floor(Number(u.value.expiresInMs) / 1000) }, uuidOf(u.value.updaterAci)];
    case 'groupMembershipAccessLevelChangeUpdate': return [{ change: 'permAddMembers', value: access(u.value.accessLevel) }, uuidOf(u.value.updaterAci)];
    case 'groupAttributesAccessLevelChangeUpdate': return [{ change: 'permEditGroup', value: access(u.value.accessLevel) }, uuidOf(u.value.updaterAci)];
    case 'groupAnnouncementOnlyChangeUpdate': return [{ change: 'permSend', value: u.value.isAnnouncementOnly ? 'only-admins' : 'every-member' }, uuidOf(u.value.updaterAci)];
    case 'groupAdminStatusUpdate': return [{ change: u.value.wasAdminStatusGranted ? 'adminAdded' : 'adminRemoved', target: uuidOf(u.value.memberAci) }, uuidOf(u.value.updaterAci)];
    case 'groupMemberLeftUpdate': return [{ change: 'left', target: uuidOf(u.value.aci) }, uuidOf(u.value.aci)];
    case 'groupMemberRemovedUpdate': return [{ change: 'memberRemoved', target: uuidOf(u.value.removedAci) }, uuidOf(u.value.removerAci)];
    case 'groupMemberAddedUpdate': return [{ change: 'memberAdded', target: uuidOf(u.value.newMemberAci) }, uuidOf(u.value.updaterAci)];
    case 'groupMemberJoinedUpdate': return [{ change: 'memberAdded', target: uuidOf(u.value.newMemberAci) }, uuidOf(u.value.newMemberAci)];
    case 'groupMemberJoinedByLinkUpdate': return [{ change: 'joinedViaLink', target: uuidOf(u.value.newMemberAci) }, uuidOf(u.value.newMemberAci)];
    case 'groupInvitationAcceptedUpdate': return [{ change: 'inviteAccepted', target: uuidOf(u.value.newMemberAci) }, uuidOf(u.value.newMemberAci)];
    case 'groupInvitationDeclinedUpdate': return [{ change: 'inviteDeclined', target: uuidOf(u.value.inviteeAci) }, uuidOf(u.value.inviteeAci)];
    case 'groupUnknownInviteeUpdate': return [{ change: 'invited', count: Math.max(1, u.value.inviteeCount) }, uuidOf(u.value.inviterAci)];
    case 'selfInvitedOtherUserToGroupUpdate': return [{ change: 'invited', count: 1 }, ''];
    case 'groupInvitationRevokedUpdate': return [{ change: 'inviteRemoved', count: Math.max(1, u.value.invitees.length) }, uuidOf(u.value.updaterAci)];
    case 'groupJoinRequestUpdate': return [{ change: 'requested', target: uuidOf(u.value.requestorAci) }, uuidOf(u.value.requestorAci)];
    case 'groupJoinRequestApprovalUpdate': return [{ change: u.value.wasApproved ? 'requestApproved' : 'requestDenied', target: uuidOf(u.value.requestorAci) }, uuidOf(u.value.updaterAci)];
    case 'groupInviteLinkResetUpdate': return [{ change: 'linkReset' }, uuidOf(u.value.updaterAci)];
    case 'groupInviteLinkEnabledUpdate': return [{ change: 'link', value: u.value.linkRequiresAdminApproval ? 'enabled-with-approval' : 'enabled' }, uuidOf(u.value.updaterAci)];
    case 'groupInviteLinkAdminApprovalUpdate': return [{ change: 'link', value: u.value.linkRequiresAdminApproval ? 'enabled-with-approval' : 'enabled' }, uuidOf(u.value.updaterAci)];
    case 'groupInviteLinkDisabledUpdate': return [{ change: 'link', value: 'disabled' }, uuidOf(u.value.updaterAci)];
    default: return [null, ''];
  }
}

function groupChanges(updates: GroupChangeChatUpdate_Update[]): { changes: HistoryGroupUpdate[]; author: string } {
  const changes: HistoryGroupUpdate[] = [];
  let author = '';
  for (const u of updates.slice(0, MAX_GROUP_UPDATES)) {
    const [change, by] = groupChange(u.update);
    if (!change) continue;
    changes.push(change);
    if (!author) author = by;
  }
  return { changes, author };
}

/** The notice for a chat update, set on `msg`; false when Beacon shows no line for it. `msg.author` becomes the group change's author when the archive names one. */
export function updateInto(u: ChatUpdateMessage, msg: HistoryMessage, inGroup: boolean): boolean {
  const v = u.update;
  switch (v.case) {
    case 'simpleUpdate': {
      const t = v.value.type;
      if (t === SimpleChatUpdate_Type.IDENTITY_UPDATE) msg.notice = { kind: 'safetyNumber' };
      else if (t === SimpleChatUpdate_Type.PAYMENTS_ACTIVATED) msg.notice = { kind: 'payment', value: 'activated' };
      else if (t === SimpleChatUpdate_Type.PAYMENT_ACTIVATION_REQUEST) msg.notice = { kind: 'payment', value: 'activationRequest' };
      else return false;
      return true;
    }
    case 'expirationTimerChange':
      if (inGroup) return false;
      msg.notice = { kind: 'timer', seconds: Math.floor(Number(v.value.expiresInMs) / 1000) };
      return true;
    case 'individualCall':
      msg.notice = { kind: 'missedCall', video: v.value.type === IndividualCall_Type.VIDEO_CALL || undefined };
      return true;
    case 'groupCall':
      msg.notice = { kind: 'groupCall' };
      return true;
    case 'pollTerminate':
      msg.notice = { kind: 'pollEnded', text: v.value.question.slice(0, MAX_TEXT) };
      return true;
    case 'groupChange': {
      if (!inGroup) return false;
      const { changes, author } = groupChanges(v.value.updates);
      if (!changes.length) return false;
      msg.groupUpdates = changes;
      if (author) msg.author = author;
      return true;
    }
    default:
      return false;
  }
}
