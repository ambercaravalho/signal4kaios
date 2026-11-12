/* Message history when linking (Signal's link-and-sync): wait for the phone's archive, download it into IndexedDB, then import it. The app drives the steps so it can show progress and resume after a reload. */

import { fromBase64 } from '../bytes';
import { host } from '../host';
import { accountBasicAuth } from '../net/http';
import { groupIdFromMasterKey } from '../services/groups-v2';
import { downloadArchive } from '../services/history/download';
import { importArchive } from '../services/history/import';
import { loadFrameMapper } from '../services/history/load';
import { type TransferArchive, waitForTransferArchive } from '../services/history/transfer';
import type { HistoryContact, HistoryGroup, HistoryItem } from '../services/history/types';
import { mergeSyncedContacts, saveSyncedGroups, syncedGroups } from './contacts';
import { client, httpJson, serverUrl, store } from './context';

export type { TransferArchive } from '../services/history/transfer';
export type { HistoryAccount, HistoryChat, HistoryContact, HistoryGroup, HistoryItem, HistoryMessage } from '../services/history/types';

const chunkKey = (i: number) => 'historyChunk:' + i;

async function account() {
  const acc = await store.getAccount();
  if (!acc) throw new Error('Not linked');
  return acc;
}

/** People and groups from the archive go into the synced directory, like Storage Service records; profile keys let their names load. */
async function saveDirectory(contacts: HistoryContact[], groups: HistoryGroup[]): Promise<void> {
  if (contacts.length) {
    for (const c of contacts) if (c.aci && c.profileKey) client.setPeerProfileKey(c.aci, fromBase64(c.profileKey));
    await mergeSyncedContacts(
      contacts,
      (c) => c.aci || c.e164,
      (c, prev) => ({
        ...prev,
        uuid: c.aci || prev.uuid || '',
        number: c.e164 || prev.number || '',
        name: prev.name || c.name || c.e164 || c.aci,
        blocked: prev.blocked ?? c.blocked,
        whitelisted: prev.whitelisted ?? c.whitelisted,
        profileKey: prev.profileKey || c.profileKey,
      })
    );
  }
  if (groups.length) {
    const byId = new Map<string, any>();
    for (const g of await syncedGroups()) byId.set(g.internal_id, g);
    for (const g of groups) {
      const prev = byId.get(g.groupId) || {};
      byId.set(g.groupId, {
        ...prev,
        id: 'group.' + g.groupId,
        internal_id: g.groupId,
        masterKey: g.masterKey,
        name: prev.name && prev.name !== 'Group' ? prev.name : g.title || 'Group',
        members: prev.members || [],
        blocked: prev.blocked ?? g.blocked,
        whitelisted: prev.whitelisted ?? g.whitelisted,
      });
    }
    await saveSyncedGroups(Array.from(byId.values()));
  }
}

export const historyMethods = {
  /** Wait up to an hour for the phone to upload message history. Null when it timed out or `cancelled` turned true. */
  async waitForTransferArchive(cancelled: () => boolean): Promise<TransferArchive | null> {
    return waitForTransferArchive(httpJson, serverUrl(), accountBasicAuth(await account()), cancelled);
  },

  /** Download the archive into IndexedDB from chunk `from` on; resolves to the number of chunks. `onChunk` runs after each one is saved. */
  downloadTransferArchive(archive: { cdn: number; key: string }, from: number, onChunk: (chunks: number, bytes: number, total: number) => Promise<void> | void, cancelled: () => boolean): Promise<number> {
    const sink = { put: (i: number, bytes: Uint8Array) => host().db.kvSet(chunkKey(i), bytes) };
    return downloadArchive((m, u, b, h, t) => host().http.rawRequest(m, u, b, h, t), archive, from, sink, onChunk, cancelled);
  },

  /**
   * Import a downloaded archive of `chunks` chunks. People and groups are saved to the directory here; `onItems` gets every item, in archive order, so the app can store chats and messages and name people while it does. `onProgress` runs with the pass (1 checks the file, 2 imports it) and the fraction done.
   */
  async importTransferArchive(
    // SECURITY-REVIEW: the ephemeral backup key from linking; it reaches only libsignal.
    backupKey: Uint8Array,
    chunks: number,
    onItems: (items: HistoryItem[]) => Promise<void>,
    onProgress: (passNumber: 1 | 2, fraction: number) => void,
    cancelled: () => boolean
  ): Promise<void> {
    const acc = await account();
    const createMapper = await loadFrameMapper();
    const mapper = createMapper({ aci: acc.aci, e164: acc.number || '' }, groupIdFromMasterKey, Date.now());
    const source = {
      count: chunks,
      async get(i: number): Promise<Uint8Array> {
        const bytes = await host().db.kvGet(chunkKey(i));
        if (!(bytes instanceof Uint8Array)) throw Object.assign(new Error('Archive chunk missing'), { name: 'BackupCorrupt' });
        return bytes;
      },
    };
    const onBatch = async (items: HistoryItem[]) => {
      await saveDirectory(
        items.filter((i): i is HistoryContact => i.t === 'contact'),
        items.filter((i): i is HistoryGroup => i.t === 'group')
      );
      await onItems(items);
    };
    await importArchive(backupKey, acc.aci, source, mapper, onBatch, (p, done, total) => onProgress(p, total ? done / total : 1), cancelled);
    await host().directoryChanged().catch(() => {});
  },

  /** Drop the downloaded chunks. */
  async discardTransferArchive(chunks: number): Promise<void> {
    for (let i = 0; i < chunks; i++) await host().db.kvSet(chunkKey(i), null);
  },
};
