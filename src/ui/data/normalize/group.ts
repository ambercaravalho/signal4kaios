/* Group change lines. */

import type { GroupUpdateKind } from '../../../engine/services/group-updates';
import type { Notice } from '../types';
import type { StoreEvent } from './events';
import { num, str } from './fields';

const GROUP_UPDATE_KINDS: GroupUpdateKind[] = [
  'title',
  'description',
  'timer',
  'permAddMembers',
  'permEditGroup',
  'permSend',
  'link',
  'linkReset',
  'memberAdded',
  'joinedViaLink',
  'inviteAccepted',
  'requestApproved',
  'memberRemoved',
  'left',
  'adminAdded',
  'adminRemoved',
  'invited',
  'inviteRemoved',
  'inviteDeclined',
  'requested',
  'requestDenied',
];
const GROUP_VALUES = ['only-admins', 'every-member', 'disabled', 'enabled', 'enabled-with-approval'];
const MAX_GROUP_UPDATES = 50;

/** Lines for what changed in a group, made by the engine from two group states. Each gets its own millisecond so their IDs stay distinct. */
export function groupUpdateEvents(gu: any): StoreEvent[] {
  const groupId = str(gu && gu.groupId);
  const changes: any[] = Array.isArray(gu && gu.changes) ? gu.changes.slice(0, MAX_GROUP_UPDATES) : [];
  if (!groupId) return [];
  const author = str(gu.author);
  const ts = num(gu.timestamp) || Date.now();
  const out: StoreEvent[] = [];
  for (const c of changes) {
    const change = str(c && c.change) as GroupUpdateKind;
    if (GROUP_UPDATE_KINDS.indexOf(change) < 0) continue;
    const notice: Notice = { kind: 'groupUpdate', change };
    if (str(c.target)) notice.target = str(c.target);
    if (str(c.text)) notice.text = str(c.text).slice(0, 300);
    if (typeof c.seconds === 'number' && c.seconds >= 0) notice.seconds = c.seconds;
    if (GROUP_VALUES.indexOf(str(c.value)) >= 0) notice.value = str(c.value);
    if (GROUP_VALUES.indexOf(str(c.from)) >= 0) notice.from = str(c.from);
    if (typeof c.count === 'number' && c.count > 0) notice.count = Math.min(c.count, 1000);
    out.push({ type: 'notice', convId: 'g:' + groupId, groupInternalId: groupId, author, timestamp: ts + out.length, notice });
  }
  return out;
}
