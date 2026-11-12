import { useState } from 'preact/hooks';
import type { ChatFolderEdit } from '../../../engine';
import { router } from '../../app/router';
import { pickMany, prompt } from '../../components/Overlays';
import { Row, RowList } from '../../components/RowList';
import { Screen } from '../../components/Screen';
import { toggleRow } from '../../components/setting-rows';
import { toast } from '../../components/Toast';
import * as store from '../../data/store';
import type { ChatFolder } from '../../data/store';
import type { Conversation } from '../../data/types';
import { friendlyError } from '../../errors';
import { plural, S } from '../../strings';

export function blankFolder(): ChatFolderEdit {
  return { name: '', showOnlyUnread: false, showMutedChats: true, includeAllIndividualChats: false, includeAllGroupChats: false, included: [], excluded: [] };
}

function editOf(f: ChatFolder): ChatFolderEdit {
  const { id, name, showOnlyUnread, showMutedChats, includeAllIndividualChats, includeAllGroupChats, included, excluded } = f;
  return { id, name, showOnlyUnread, showMutedChats, includeAllIndividualChats, includeAllGroupChats, included, excluded };
}

function allChats(): Conversation[] {
  return store
    .conversations()
    .concat(store.archivedConversations())
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

/** Pick chats for a folder's list; keys of chats this phone doesn't show stay in the list. */
async function pickChats(title: string, keys: string[]): Promise<string[] | undefined> {
  const chats = allChats();
  const chosen = chats.filter((c) => store.folderNames(keys, c)).map((c) => c.id);
  const picked = await pickMany(title, chats.map((c) => ({ value: c.id, label: c.name || S.unknown })), chosen);
  if (!picked) return undefined;
  const unseen = keys.filter((k) => !chats.some((c) => store.folderNames([k], c)));
  return unseen.concat(picked);
}

function chatCount(keys: string[]): string {
  return plural(allChats().filter((c) => store.folderNames(keys, c)).length, S.chatOne, S.chatMany);
}

/** Create or edit a chat folder: its name, which chats it holds, and which it leaves out. */
export function EditFolderScreen(props: { folder?: ChatFolder }) {
  const [edit, setEdit] = useState<ChatFolderEdit>(() => (props.folder ? editOf(props.folder) : blankFolder()));
  const [saving, setSaving] = useState(false);
  const change = (patch: Partial<ChatFolderEdit>) => setEdit((e) => ({ ...e, ...patch }));

  async function rename(): Promise<void> {
    const name = await prompt({ title: S.folderName, value: edit.name, hint: S.folderNameHint });
    if (name === undefined) return;
    if (store.graphemeCount(name) > store.FOLDER_NAME_MAX) toast(S.folderNameTooLong);
    else change({ name });
  }

  async function chooseChats(which: 'included' | 'excluded'): Promise<void> {
    const keys = await pickChats(which === 'included' ? S.includedChats : S.excludedChats, edit[which]);
    if (keys) change({ [which]: keys } as Partial<ChatFolderEdit>);
  }

  function save(): void {
    if (saving) return;
    if (!edit.name.trim()) {
      toast(S.folderNameNeeded);
      return;
    }
    setSaving(true);
    store.saveFolder(edit).then(
      () => {
        toast(S.saved);
        router.pop();
      },
      (e) => {
        setSaving(false);
        toast(friendlyError(e));
      }
    );
  }

  const rows: Row[] = [
    { key: 'name', label: S.folderName, sub: edit.name || S.noFolderName, action: S.edit, onSelect: rename },
    { section: S.includedChats },
    { key: 'included', label: S.chooseChats, sub: chatCount(edit.included), action: S.edit, onSelect: () => chooseChats('included') },
    toggleRow('direct', S.allIndividualChats, edit.includeAllIndividualChats, (v) => change({ includeAllIndividualChats: v })),
    toggleRow('groups', S.allGroupChats, edit.includeAllGroupChats, (v) => change({ includeAllGroupChats: v })),
    { section: S.excludedChats },
    { key: 'excluded', label: S.chooseChats, sub: chatCount(edit.excluded), action: S.edit, onSelect: () => chooseChats('excluded') },
    { section: '' },
    toggleRow('unread', S.onlyUnreadChats, edit.showOnlyUnread, (v) => change({ showOnlyUnread: v })),
    toggleRow('muted', S.showMutedChats, edit.showMutedChats, (v) => change({ showMutedChats: v })),
  ];
  return (
    <Screen title={props.folder ? S.editFolder : S.newFolder}>
      <RowList
        rows={rows}
        softkeys={() => ({ right: saving ? null : S.save })}
        onKey={(e) => {
          if (e.key !== 'SoftRight') return false;
          save();
          return true;
        }}
      />
    </Screen>
  );
}
