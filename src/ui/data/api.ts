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
  whitelisted?: boolean;
  systemContact?: boolean;
  expireTimer?: number;
  username?: string;
  profile_name?: string;
  nickname?: { name?: string; given_name?: string; family_name?: string };
  profile?: { given_name?: string; lastname?: string; has_avatar?: boolean };
}

export type GroupDetail = GroupV2Metadata;

function storedList<T>(key: string): Promise<T[]> {
  return db.kvGet(key).then((l) => (Array.isArray(l) ? (l as T[]) : []), () => []);
}

export function syncedContacts(): Promise<SyncedContact[]> {
  return storedList('syncedContacts');
}

export function syncedGroups(): Promise<GroupDetail[]> {
  return storedList('syncedGroups');
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

/** Read receipts on or off here and, through Storage Service, on your other devices; a pull would otherwise put back the old value. */
export function setReadReceipts(on: boolean): Promise<void> {
  config.set({ sendReadReceipts: on });
  return signal.setReadReceipts(on);
}

/** Typing indicators on or off here and on your other devices. */
export function setTypingIndicators(on: boolean): Promise<void> {
  config.set({ typingIndicators: on });
  return signal.setTypingIndicators(on);
}

/** Remove this phone's account data: messages and keys. */
export function unlink(): Promise<void> {
  return db.wipe().catch(() => {});
}

/** Point the store at the account being linked, with no keys or sessions left from an earlier link of it; its history stays. */
export async function openLinkDatabase(account: { aci: string; number: string }): Promise<void> {
  await db.useAccount(account.number || account.aci);
  await db.clearSignalState();
}

/** Unlinking forgot the active account: switch to the next saved one, if any. The caller reloads. */
export function leaveUnlinkedAccount(): void {
  config.forgetAccount();
  const next = config.accounts()[0];
  if (next) config.switchAccount(next.number);
}

/** Delete every Beacon database on this phone; settings go only when they all did, so a failed attempt can be tried again. Resolves to whether everything went. */
export async function wipeAllData(): Promise<boolean> {
  const names = [db.nameFor(''), db.name(), ...config.knownDatabases(), ...config.accounts().map((a) => db.nameFor(a.dbNumber || a.number)), ...(await db.listDatabases())];
  const failed = await db.deleteDatabases(names.filter((n, i) => names.indexOf(n) === i));
  if (failed.length) return false;
  // SECURITY-REVIEW: this drops every account's device credentials from config.
  config.clear();
  return true;
}

/** Signal unlinked this phone: its keys and credentials are useless now, so delete them and keep the message history. */
export function forgetUnlinkedDevice(): Promise<void> {
  return db.clearSignalState().catch(() => {});
}
