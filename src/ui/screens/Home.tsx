import { useState } from 'preact/hooks';
import { useStoreEvents } from '../app/hooks';
import { router } from '../app/router';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { Badge, EmptyState, Spinner } from '../components/List';
import { confirm, DIVIDER, showOptions } from '../components/Overlays';
import { EmojiText } from '../components/RichText';
import { ActionRow, Row, RowList } from '../components/RowList';
import { Screen } from '../components/Screen';
import { muteItem } from '../components/setting-rows';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { toast } from '../components/Toast';
import { fmtTime } from '../data/format';
import * as store from '../data/store';
import type { Conversation } from '../data/types';
import { friendlyError } from '../errors';
import { APP_NAME, fmt, S } from '../strings';
import { openChat } from './Chat';
import { ChatSettingsScreen } from './ChatSettings';
import { NewChatScreen, SearchScreen } from './SearchList';
import { SettingsScreen } from './Settings';

const ARCHIVED_ROW = 'archived';

function convRow(conv: Conversation, archived: boolean): ActionRow {
  const t = !archived && store.typing(conv.id);
  return {
    key: conv.id,
    label: conv.name || S.unknown,
    leading: <Avatar conv={conv} />,
    meta: (
      <>
        {conv.pinned && !archived && <Icon name="pin" class="meta-icon" />}
        {store.isMuted(conv) && <Icon name="mute" class="meta-icon" />}
        {fmtTime(conv.lastTs)}
      </>
    ),
    sub: conv.request ? (
      <span class="draft-label">{S.messageRequest}</span>
    ) : t ? (
      <span class="typing">{S.typingNow}</span>
    ) : conv.draft ? (
      <>
        <span class="draft-label">{S.draft}</span> <EmojiText text={conv.draft} />
      </>
    ) : (
      <EmojiText text={conv.lastPreview || ''} />
    ),
    badge: <Badge count={conv.unread} dot={conv.markedUnread} />,
    action: S.open,
    onSelect: () => openChat(conv.id),
  };
}

function readToggle(conv: Conversation) {
  return conv.unread > 0 || conv.markedUnread
    ? { label: S.markAsRead, onSelect: () => store.markRead(conv.id) }
    : { label: S.markAsUnread, onSelect: () => store.setMarkedUnread(conv.id, true) };
}

function deleteChatItem(conv: Conversation) {
  return {
    label: S.deleteChat,
    danger: true,
    onSelect: async () => {
      if (await confirm({ title: S.deleteChatTitle, body: S.deleteChatBody, ok: S.delete, danger: true })) store.deleteChat(conv.id).catch((e) => toast(friendlyError(e)));
    },
  };
}

function homeOptions(conv: Conversation | undefined): void {
  showOptions([
    conv && { label: S.chatSettings, onSelect: () => router.push(ChatSettingsScreen, { convId: conv.id }) },
    conv && { label: conv.pinned ? S.unpinChat : S.pinChat, onSelect: () => store.setConvPinned(conv.id, !conv.pinned) || toast(S.pinLimit) },
    conv && { label: S.archive, onSelect: () => store.setArchived(conv.id, true) },
    conv && muteItem(conv),
    conv && readToggle(conv),
    DIVIDER,
    { label: S.markAllRead, onSelect: () => store.markAllRead() },
    DIVIDER,
    { label: S.search, onSelect: () => router.push(SearchScreen, {}) },
    { label: S.settings, onSelect: () => router.push(SettingsScreen, {}) },
    conv && DIVIDER,
    conv && deleteChatItem(conv),
  ]);
}

/** The folder the chat list shows, kept while the app runs; null is "All chats". */
let shownFolder: string | null = null;

/** The chat list, one chat folder at a time (Left and Right switch). Archived chats sit behind a row at the bottom of "All chats", as in Signal for Android. */
export function HomeScreen() {
  useStoreEvents(['conversations', 'typing']);
  const [, setShown] = useState(shownFolder);
  const folders = store.foldersInOrder();
  const folder = folders.find((f) => !f.all && f.id === shownFolder) || folders.find((f) => f.all);
  const custom = !!folder && !folder.all;
  const list = custom ? store.conversations().filter((c) => store.folderIncludes(folder!, c)) : store.conversations();
  const archivedCount = custom ? 0 : store.archivedConversations().length;
  const rows: Row[] = list.map((c) => convRow(c, false));
  if (archivedCount)
    rows.push({ key: ARCHIVED_ROW, label: S.archivedChats, icon: 'archive', meta: String(archivedCount), action: S.open, onSelect: () => router.push(ArchivedScreen, {}) });

  function switchFolder(by: number): void {
    const i = folder ? folders.indexOf(folder) : -1;
    const next = folders[(i + by + folders.length) % folders.length];
    shownFolder = next.all ? null : next.id;
    setShown(shownFolder);
  }

  const empty = !store.isReady() ? (
    <Spinner />
  ) : custom ? (
    <EmptyState title={S.noChatsInFolder} body={S.noChatsInFolderHint} pictogram="chats" />
  ) : (
    <EmptyState title={S.noChats} body={S.noChatsHint} pictogram="chats" />
  );
  const name = custom ? folder!.name : folders.length > 1 ? S.allChats : APP_NAME;

  return (
    <Screen title={folders.length > 1 ? fmt(S.folderTitle, { name }) : name} banner={<ConnectionBanner />}>
      <RowList
        rows={rows}
        empty={empty}
        softkeys={() => ({ left: S.newChat, right: S.options })}
        onKey={(e, row) => {
          if (e.key === 'SoftLeft') router.push(NewChatScreen, {});
          else if (e.key === 'SoftRight') homeOptions(row && row.key !== ARCHIVED_ROW ? store.conversation(row.key!) : undefined);
          else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && folders.length > 1) switchFolder(e.key === 'ArrowLeft' ? -1 : 1);
          else return false;
          return true;
        }}
      />
    </Screen>
  );
}

/** Archived chats, opened from the row at the bottom of the chat list. */
export function ArchivedScreen() {
  useStoreEvents(['conversations']);
  const list = store.archivedConversations();
  return (
    <Screen title={S.archivedChats}>
      <RowList
        rows={list.map((c) => convRow(c, true))}
        empty={<EmptyState title={S.noArchived} body={S.noArchivedHint} pictogram="archive" />}
        softkeys={(row) => ({ right: row ? S.options : null })}
        onKey={(e, row) => {
          const conv = e.key === 'SoftRight' && row ? store.conversation(row.key!) : undefined;
          if (!conv) return false;
          showOptions([
            { label: S.chatSettings, onSelect: () => router.push(ChatSettingsScreen, { convId: conv.id }) },
            { label: S.unarchive, onSelect: () => store.setArchived(conv.id, false) },
            muteItem(conv),
            readToggle(conv),
            DIVIDER,
            deleteChatItem(conv),
          ]);
          return true;
        }}
      />
    </Screen>
  );
}
