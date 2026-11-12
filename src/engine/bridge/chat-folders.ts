/* Chat folders made or changed in Beacon, written to Storage Service so the account's other devices get them, like Signal-Desktop's chat folder settings. */

import { fromBase64, randomBytes, toBase64 } from '../bytes';
import { chatFolderId, ensureAllChatsFolder, type FolderRecipient, markChatFolderDeleted, writeChatFolder } from '../services/storage/chat-folders';
import type { StorageMutation } from '../services/storage';
import { contactIds, syncedGroups } from './contacts';
import { storageQueue } from './context';

/** A folder as the settings screen edits it. Chats are named the way the app keys them: a number or ACI, or `g:` + a group's internal ID. */
export interface ChatFolderEdit {
  /** Unset for a new folder. */
  id?: string;
  name: string;
  showOnlyUnread: boolean;
  showMutedChats: boolean;
  includeAllIndividualChats: boolean;
  includeAllGroupChats: boolean;
  included: string[];
  excluded: string[];
}

/** Each chat once, as Storage names it; chats we can't name (no ACI or number, an unknown group) are left out. */
async function recipientsOf(keys: string[]): Promise<FolderRecipient[]> {
  const out: FolderRecipient[] = [];
  const seen = new Set<string>();
  const groups = keys.some((k) => k.startsWith('g:')) ? await syncedGroups() : [];
  for (const key of keys) {
    if (key.startsWith('g:')) {
      const g = groups.find((x) => x.internal_id === key.slice(2));
      if (!g || !g.masterKey || seen.has(key)) continue;
      seen.add(key);
      out.push({ masterKey: fromBase64(g.masterKey) });
      continue;
    }
    const ids = await contactIds(key);
    const id = ids.aci || ids.e164;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ aci: ids.aci || undefined, e164: ids.e164 || undefined });
  }
  return out;
}

export const chatFolderMethods = {
  /**
   * Create or change a custom folder; resolves to its ID. A new folder goes at `position`; the first one also creates the "All chats" folder, as Signal does.
   */
  async saveChatFolder(folder: ChatFolderEdit, position?: number): Promise<string> {
    const name = folder.name.normalize().trim();
    if (!name) throw new Error('A chat folder needs a name');
    const id = folder.id ? chatFolderId(folder.id) : randomBytes(16);
    const fields = { ...folder, name, included: await recipientsOf(folder.included), excluded: await recipientsOf(folder.excluded) };
    const mutations: StorageMutation[] = [{ type: 'chatFolder', id, update: (f) => writeChatFolder(f, fields, folder.id ? undefined : position) }];
    if (!folder.id) mutations.unshift({ type: 'chatFolder', allChats: true, update: ensureAllChatsFolder });
    await storageQueue.enqueue(mutations);
    return toBase64(id);
  },

  async deleteChatFolder(id: string): Promise<void> {
    const now = Date.now();
    await storageQueue.enqueue([{ type: 'chatFolder', id: chatFolderId(id), existing: true, update: (f) => markChatFolderDeleted(f, now) }]);
  },

  /** Give each folder in `ids` (the "All chats" folder included) the position of its index. */
  async reorderChatFolders(ids: string[]): Promise<void> {
    const mutations: StorageMutation[] = ids.map((id, position) => ({
      type: 'chatFolder',
      id: chatFolderId(id),
      existing: true,
      update: (f) => {
        if (f.deletedAtTimestampMs === 0n) f.position = position;
      },
    }));
    await storageQueue.enqueue(mutations);
  },
};
