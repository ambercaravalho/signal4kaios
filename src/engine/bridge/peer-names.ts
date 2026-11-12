/* Profile names for people we only know from their messages, fetched once their profile key arrives, as Signal-Desktop's profile service does on a new key. */

import { fromBase64 } from '../bytes';
import { host } from '../host';
import { isAci } from '../net/proto';
import { fetchAndDecryptProfile } from '../services/profiles';
import { saveSyncedContacts, syncedContacts } from './contacts';
import { client, httpJson, serverUrl, store } from './context';

const asked = new Set<string>();
let queue: Promise<void> = Promise.resolve();
let waiting = 0;
let changed = false;

async function fetchName(aci: string): Promise<void> {
  const contacts = await syncedContacts();
  const entry = contacts.find((c) => c.uuid === aci);
  const key = client.getPeerProfileKey(aci) || (entry && entry.profileKey ? fromBase64(entry.profileKey) : undefined);
  if (!entry || !key) return;
  const prof = await fetchAndDecryptProfile(store, httpJson, aci, key, serverUrl());
  if (!prof || !prof.fullName || prof.fullName === entry.profile_name) return;
  const fresh = await syncedContacts();
  const row = fresh.find((c) => c.uuid === aci);
  if (!row) return;
  row.profile_name = prof.fullName;
  await saveSyncedContacts(fresh);
  changed = true;
}

/** Fetch this person's profile name in the background, once per session; the app's directory refreshes when the queue is done. */
export function queuePeerName(aci: string): void {
  if (!isAci(aci) || asked.has(aci)) return;
  asked.add(aci);
  waiting++;
  queue = queue
    .then(() => fetchName(aci))
    .catch(() => {})
    .then(() => {
      if (--waiting || !changed) return;
      changed = false;
      host().directoryChanged().catch(() => {});
    });
}

/** Forget who was asked, so the next message tries again; for tests. */
export function resetPeerNamesForTest(): void {
  asked.clear();
}
