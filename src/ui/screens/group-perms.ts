/* Who may change a group, and its detail for the settings screens. */

import { useEffect, useState } from 'preact/hooks';
import { useStoreEvents } from '../app/hooks';
import { groupDetail, type GroupDetail } from '../data/api';
import * as store from '../data/store';
import type { Conversation } from '../data/types';

export type Perm = 'every-member' | 'only-admins';
export type PermKey = 'add_members' | 'edit_group' | 'send_messages';
export const PERM_DEFAULTS: Record<PermKey, Perm> = { add_members: 'every-member', edit_group: 'only-admins', send_messages: 'every-member' };

export function amAdmin(d: GroupDetail | null): boolean {
  return !!d && (d.admins || []).some(store.isSelf);
}

export function allowed(d: GroupDetail | null, key: PermKey): boolean {
  if (!d) return false;
  const perms = d.permissions || PERM_DEFAULTS;
  return amAdmin(d) || perms[key] !== 'only-admins';
}

export function useGroupDetail(conv: Conversation | undefined): [GroupDetail | null, () => void] {
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const sendId = conv && conv.type === 'group' ? conv.sendId : null;
  const load = () => {
    if (sendId) groupDetail(sendId).then(setDetail, () => {});
  };
  useEffect(load, [sendId]);
  useStoreEvents(['conversations']);
  return [detail, load];
}
