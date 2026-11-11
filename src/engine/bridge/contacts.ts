/* The synced directory the app keeps in IndexedDB (`syncedContacts`, `syncedGroups`), and resolving people to the ACIs Signal addresses. */

import { toBase64 } from '../bytes';
import { host } from '../host';
import { isAci } from '../net/proto';
import { client } from './context';

/** A `syncedContacts` entry; fields come from contact sync, Storage Service, and profiles, so every one is optional. */
export type SyncedContactRow = Record<string, any>;
/** A `syncedGroups` entry: the group's `GroupV2Metadata` plus local flags. */
export type SyncedGroupRow = Record<string, any>;

export async function syncedContacts(): Promise<SyncedContactRow[]> {
  return (await host().db.kvGet('syncedContacts')) || [];
}

export function saveSyncedContacts(list: SyncedContactRow[]): Promise<void> {
  return host().db.kvSet('syncedContacts', list);
}

export async function syncedGroups(): Promise<SyncedGroupRow[]> {
  return (await host().db.kvGet('syncedGroups')) || [];
}

export function saveSyncedGroups(list: SyncedGroupRow[]): Promise<void> {
  return host().db.kvSet('syncedGroups', list);
}

/** Upsert `items` into `syncedContacts`, keyed by ACI, else number; `merge` builds each entry from the stored one (`{}` when new). */
export async function mergeSyncedContacts<T>(items: T[], idOf: (item: T) => string | undefined, merge: (item: T, prev: SyncedContactRow) => SyncedContactRow): Promise<void> {
  const byId = new Map<string, SyncedContactRow>();
  for (const c of await syncedContacts()) byId.set(c.uuid || c.number, c);
  for (const item of items) {
    const id = idOf(item);
    if (id) byId.set(id, merge(item, byId.get(id) || {}));
  }
  await saveSyncedContacts(Array.from(byId.values()));
}

/** A contact's ACI and phone number from either one, via `syncedContacts`. */
export async function contactIds(id: string): Promise<{ aci: string; e164: string }> {
  const contacts = await syncedContacts();
  const hit = contacts.find((c) => (id && c.uuid === id) || (id && c.number === id));
  const aci = isAci(id) ? id : hit && isAci(hit.uuid) ? hit.uuid : '';
  const e164 = id.startsWith('+') ? id : (hit && hit.number) || '';
  return { aci, e164 };
}

/** Read-modify-write one `syncedContacts` entry (created when missing). */
export async function updateSyncedContact(ids: { aci: string; e164: string }, update: (c: SyncedContactRow) => void): Promise<void> {
  const list = await syncedContacts();
  let entry = list.find((c) => (ids.aci && c.uuid === ids.aci) || (ids.e164 && c.number === ids.e164));
  if (!entry) {
    entry = { uuid: ids.aci, number: ids.e164, name: ids.e164 || ids.aci, blocked: false, expireTimer: 0 };
    list.push(entry);
  }
  update(entry);
  await saveSyncedContacts(list);
}

/** Read-modify-write one `syncedGroups` entry. */
export async function updateSyncedGroup(internalId: string, update: (g: SyncedGroupRow) => void): Promise<void> {
  const list = await syncedGroups();
  const entry = list.find((g) => g.internal_id === internalId);
  if (!entry) return;
  update(entry);
  await saveSyncedGroups(list);
}

/** Signal addresses users by ACI; map a phone number to its ACI through the synced contact list. */
export async function resolveAci(id: string): Promise<string> {
  if (isAci(id)) return id;
  const hit = (await syncedContacts()).find((c) => c.number === id && isAci(c.uuid));
  return hit ? hit.uuid : '';
}

export async function resolveRecipients(ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    const aci = await resolveAci(id);
    if (!aci) throw new Error('No Signal account known for ' + id);
    out.push(aci);
  }
  return out;
}

/** Persist a sender's 32-byte ProfileKey onto `syncedContacts` and in-memory `SignalClient`. */
export async function recordPeerProfileKey(senderUuid: string, senderE164: string | undefined, profileKeyBytes: Uint8Array): Promise<void> {
  if (profileKeyBytes.length !== 32 || !isAci(senderUuid)) return;
  client.setPeerProfileKey(senderUuid, profileKeyBytes);
  const b64 = toBase64(profileKeyBytes);
  const list = await syncedContacts();
  let found = false;
  let changed = false;
  for (const c of list) {
    if (c.uuid === senderUuid || (senderE164 && c.number === senderE164)) {
      found = true;
      if (c.profileKey !== b64) {
        c.profileKey = b64;
        changed = true;
      }
    }
  }
  if (!found) {
    list.push({ uuid: senderUuid, number: senderE164 || '', name: senderE164 || senderUuid, blocked: false, expireTimer: 0, profileKey: b64 });
    changed = true;
  }
  if (changed) await saveSyncedContacts(list);
}
