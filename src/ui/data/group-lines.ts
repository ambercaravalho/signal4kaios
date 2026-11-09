/* What a group update or timer line says, with Signal-Desktop's wording (groupChange.std.ts): "you" for us, the person's name otherwise, and a passive sentence when who made the change isn't known. */

import { fmt, plural, S } from '../strings';
import { expireLabel } from './format';
import type { Notice } from './types';

export interface LineNames {
  /** Display name for a number or service ID. */
  name(key: string): string;
  isMe(key: string): boolean;
}

/** Picks the sentence for "you did it", "someone did it", or "it happened". */
function by(author: string, names: LineNames, active: string, passive: string, vars: Record<string, string | number> = {}): string {
  if (!author) return fmt(passive, vars);
  return fmt(active, { ...vars, who: names.isMe(author) ? S.you : names.name(author) });
}

export function timerText(seconds: number, author: string, names: LineNames): string {
  if (!seconds) return by(author, names, S.gTimerOff, S.gTimerOffP);
  return by(author, names, S.gTimer, S.gTimerP, { time: expireLabel(seconds).toLowerCase() });
}

function permLabel(value: string | undefined): string {
  return value === 'only-admins' ? S.onlyAdmins : S.allMembers;
}

export function groupUpdateText(n: Notice, author: string, names: LineNames): string {
  const target = n.target || '';
  const me = !!target && names.isMe(target);
  const name = target ? names.name(target) : '';
  const count = n.count || 0;
  switch (n.change) {
    case 'title':
      return by(author, names, S.gTitle, S.gTitleP, { text: n.text || '' });
    case 'description':
      return by(author, names, S.gDesc, S.gDescP);
    case 'timer':
      return timerText(n.seconds || 0, author, names);
    case 'permAddMembers':
      return by(author, names, S.gPermAdd, S.gPermAddP, { value: permLabel(n.value) });
    case 'permEditGroup':
      return by(author, names, S.gPermEdit, S.gPermEditP, { value: permLabel(n.value) });
    case 'permSend':
      return n.value === 'only-admins' ? by(author, names, S.gSendAdmins, S.gSendAdminsP) : by(author, names, S.gSendAll, S.gSendAllP);
    case 'link':
      if (n.value === 'disabled') return by(author, names, S.gLinkOff, S.gLinkOffP);
      if (n.from && n.from !== 'disabled') return n.value === 'enabled-with-approval' ? by(author, names, S.gApprovalOn, S.gApprovalOnP) : by(author, names, S.gApprovalOff, S.gApprovalOffP);
      return n.value === 'enabled-with-approval' ? by(author, names, S.gLinkOnApproval, S.gLinkOnApprovalP) : by(author, names, S.gLinkOn, S.gLinkOnP);
    case 'linkReset':
      return by(author, names, S.gLinkReset, S.gLinkResetP);
    case 'memberAdded':
      return me ? by(author, names, S.gAddedYou, S.gAddedYouP) : by(author, names, S.gAdded, S.gAddedP, { name });
    case 'joinedViaLink':
      return me ? S.gJoinedYou : fmt(S.gJoined, { name });
    case 'inviteAccepted':
      return me ? S.gAcceptedYou : fmt(S.gAccepted, { name });
    case 'requestApproved':
      return me ? by(author, names, S.gApprovedYou, S.gApprovedYouP) : by(author, names, S.gApproved, S.gApprovedP, { name });
    case 'memberRemoved':
      return me ? by(author, names, S.gRemovedYou, S.gRemovedYouP) : by(author, names, S.gRemoved, S.gRemovedP, { name });
    case 'left':
      return me ? S.gLeftYou : fmt(S.gLeft, { name });
    case 'adminAdded':
      return me ? by(author, names, S.gAdminYou, S.gAdminYouP) : by(author, names, S.gAdmin, S.gAdminP, { name });
    case 'adminRemoved':
      return me ? by(author, names, S.gUnadminYou, S.gUnadminYouP) : by(author, names, S.gUnadmin, S.gUnadminP, { name });
    case 'invited':
      if (me) return by(author, names, S.gInvitedYou, S.gInvitedYouP);
      return by(author, names, S.gInvited, count === 1 ? S.gInvitedP1 : S.gInvitedPN, { people: plural(count, S.personOne, S.personMany), count });
    case 'inviteRemoved':
      return count === 1 ? by(author, names, S.gRevoked1, S.gRevokedP1) : by(author, names, S.gRevokedN, S.gRevokedPN, { count });
    case 'inviteDeclined':
      return fmt(S.gDeclined, { name });
    case 'requested':
      return me ? S.gRequestedYou : fmt(S.gRequested, { name });
    case 'requestDenied':
      if (author && author === target) return fmt(S.gRequestCanceled, { name });
      return by(author, names, S.gDenied, S.gDeniedP, { name });
    default:
      return S.gChanged;
  }
}
