import { useStoreEvents } from '../../app/hooks';
import { router } from '../../app/router';
import { confirm, pick, showOptions } from '../../components/Overlays';
import { Row, RowList } from '../../components/RowList';
import { Screen } from '../../components/Screen';
import { runAction } from '../../components/setting-rows';
import { toast } from '../../components/Toast';
import * as store from '../../data/store';
import type { ChatFolder } from '../../data/store';
import { friendlyError } from '../../errors';
import { plural, S } from '../../strings';
import { guideRow } from '../Guide';
import { blankFolder, EditFolderScreen } from './EditFolder';

const ADD_ROW = 'add';

type Preset = 'unread' | 'individual' | 'groups' | 'custom';

/** Signal-Desktop `CHAT_FOLDER_PRESETS`. */
function presetFolder(p: Exclude<Preset, 'custom'>) {
  const f = blankFolder();
  if (p === 'unread') return { ...f, name: S.folderUnread, showOnlyUnread: true, includeAllIndividualChats: true, includeAllGroupChats: true };
  if (p === 'individual') return { ...f, name: S.folderIndividual, includeAllIndividualChats: true };
  return { ...f, name: S.folderGroups, includeAllGroupChats: true };
}

async function addFolder(): Promise<void> {
  const p = await pick<Preset>(
    S.addFolder,
    [
      { value: 'unread', label: S.folderUnread },
      { value: 'individual', label: S.folderIndividual },
      { value: 'groups', label: S.folderGroups },
      { value: 'custom', label: S.folderCustom },
    ],
    'custom'
  );
  if (!p) return;
  if (p === 'custom') router.push(EditFolderScreen, { folder: undefined });
  else runAction(store.saveFolder(presetFolder(p)), S.saved);
}

function folderOptions(f: ChatFolder, i: number, count: number): void {
  showOptions([
    i > 0 && { label: S.moveUp, onSelect: () => store.moveFolder(f.id, -1).catch((e) => toast(friendlyError(e))) },
    i < count - 1 && { label: S.moveDown, onSelect: () => store.moveFolder(f.id, 1).catch((e) => toast(friendlyError(e))) },
    !f.all && { label: S.deleteFolder, danger: true, onSelect: () => removeFolder(f) },
  ]);
}

async function removeFolder(f: ChatFolder): Promise<void> {
  if (await confirm({ title: S.deleteFolder + '?', body: S.deleteFolderBody, ok: S.delete, danger: true })) runAction(store.deleteFolder(f.id), S.folderDeleted);
}

/** Settings → Chats → Chat folders: the folders in order, as Home switches through them. */
export function ChatFoldersScreen() {
  useStoreEvents(['conversations']);
  const folders = store.foldersInOrder();
  const chats = store.conversations();
  const rows: Row[] = [
    { key: ADD_ROW, label: S.addFolder, onSelect: addFolder },
    { section: '' },
    ...folders.map((f) => ({
      key: f.id || 'all',
      label: f.all ? S.allChats : f.name,
      sub: plural(f.all ? chats.length : chats.filter((c) => store.folderIncludes(f, c)).length, S.chatOne, S.chatMany),
      action: f.all ? undefined : S.edit,
      onSelect: f.all ? undefined : () => router.push(EditFolderScreen, { folder: f }),
    })),
    { section: S.chatFoldersHint },
    guideRow('folders'),
  ];
  return (
    <Screen title={S.chatFolders}>
      <RowList
        rows={rows}
        softkeys={(row) => ({ right: row && row.key !== ADD_ROW && folders.length > 1 ? S.options : null })}
        onKey={(e, row) => {
          if (e.key !== 'SoftRight' || !row || row.key === ADD_ROW || folders.length < 2) return false;
          const i = folders.findIndex((f) => (f.id || 'all') === row.key);
          if (i >= 0) folderOptions(folders[i], i, folders.length);
          return true;
        }}
      />
    </Screen>
  );
}
