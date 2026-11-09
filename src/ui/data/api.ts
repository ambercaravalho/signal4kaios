/* App-level Signal operations that combine the engine with local state. Everything else, screens call on `signal` directly. */

import { signalBridge as signal } from '../../engine';
import type { GroupV2Metadata } from '../../engine/services/groups-v2';
import { config } from './config';
import { db } from './db';

export { signal };

export interface SyncedContact {
  uuid: string;
  number: string;
  name: string;
  blocked?: boolean;
  expireTimer?: number;
  username?: string;
  profile_name?: string;
  nickname?: { name?: string; given_name?: string; family_name?: string };
  profile?: { given_name?: string; lastname?: string; has_avatar?: boolean };
}

export type GroupDetail = GroupV2Metadata;

export function syncedContacts(): Promise<SyncedContact[]> {
  return db.kvGet('syncedContacts').then((l) => l || [], () => []);
}

export function syncedGroups(): Promise<GroupDetail[]> {
  return db.kvGet('syncedGroups').then((l) => l || [], () => []);
}

/** Full detail for one group by its `group.` send ID, with an empty placeholder until the group's state arrives. */
export function groupDetail(groupId: string): Promise<GroupDetail> {
  const internalId = String(groupId || '').replace(/^group\./, '');
  return syncedGroups().then(
    (list) =>
      list.find((g) => g.id === groupId || g.internal_id === internalId) || {
        id: groupId,
        internal_id: internalId,
        masterKey: '',
        revision: 0,
        name: 'Group',
        members: [],
        admins: [],
        pending: [],
        expireTimer: 0,
        blocked: false,
        link_mode: 'disabled',
        invite_link: '',
      }
  );
}

/** Rename a contact for you (a Signal nickname, synced to your devices). */
export async function renameContact(recipient: string, name: string): Promise<void> {
  const list = await syncedContacts();
  let found = false;
  for (const c of list) {
    if (c.number === recipient || c.uuid === recipient) {
      c.name = name;
      found = true;
    }
  }
  if (!found) {
    const isNumber = recipient.indexOf('+') === 0;
    list.push({ uuid: isNumber ? '' : recipient, number: isNumber ? recipient : '', name: name || recipient, blocked: false, expireTimer: 0 });
  }
  await db.kvSet('syncedContacts', list);
  await signal.setContactNickname(recipient, name);
}

export function updateProfile(body: { name?: string; about?: string; emoji?: string }): Promise<void> {
  if (body.name != null) config.set({ profileName: body.name });
  if (body.about != null) config.set({ profileAbout: body.about });
  if (body.emoji != null) config.set({ profileAboutEmoji: body.emoji });
  return signal.updateOwnProfile(body);
}

/** Remove this phone's account data: messages and keys. */
export function unlink(): Promise<void> {
  return db.wipe().catch(() => {});
}
