/* Group photos for the app: downloaded once per avatar key and kept in the attachment cache. */

import { bytesToBlob, fromBase64 } from '../bytes';
import { host } from '../host';
import { downloadAndDecryptGroupAvatar } from '../services/group-avatar';
import { deriveGroupV2Keys } from '../services/groups-v2';
import { httpBinary, store } from './context';
import { syncedGroups } from './contacts';
import { refreshGroup } from './group-state';

const cacheKey = (internalId: string) => 'avatar:group:' + internalId;
const cachedForKey = (internalId: string) => 'groupAvatarCachedFor:' + internalId;

const refreshed = new Set<string>();
let refreshes: Promise<unknown> = Promise.resolve();

/** Groups saved before their avatar key was recorded get one refresh per session, one group at a time. */
function refreshOnce(internalId: string, masterKey: Uint8Array): Promise<unknown> {
  if (refreshed.has(internalId)) return refreshes;
  refreshed.add(internalId);
  refreshes = refreshes.then(() => refreshGroup(masterKey)).catch((e: any) => host().dbg('group avatar refresh failed: ' + (e && e.message)));
  return refreshes;
}

async function groupRow(internalId: string) {
  return (await syncedGroups()).find((g) => g.internal_id === internalId);
}

export const groupAvatarMethods = {
  /** A group's photo, or null when it has none or we don't know the group. */
  async groupAvatarBlob(internalId: string): Promise<Blob | null> {
    let row = await groupRow(internalId);
    const masterKey = row && row.masterKey ? fromBase64(row.masterKey) : new Uint8Array(0);
    if (!row || masterKey.length !== 32) return null;
    if (typeof row.avatar !== 'string') {
      await refreshOnce(internalId, masterKey);
      row = await groupRow(internalId);
    }
    const key = row && typeof row.avatar === 'string' ? row.avatar : '';
    if (!key) return null;
    if ((await store.loadValue(cachedForKey(internalId))) === key) {
      const cached = await host().db.getAttachment(cacheKey(internalId));
      if (cached && cached.blob && cached.blob.size) return cached.blob;
    }
    const blob = bytesToBlob(await downloadAndDecryptGroupAvatar(httpBinary, key, deriveGroupV2Keys(masterKey).secretParams), 'image/jpeg');
    await host().db.putAttachment(cacheKey(internalId), blob, 'image/jpeg');
    await store.storeValue(cachedForKey(internalId), key);
    return blob;
  },
};
