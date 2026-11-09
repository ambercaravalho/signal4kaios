import { useStoreEvents } from '../app/hooks';
import { router } from '../app/router';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { Badge, EmptyState, Spinner } from '../components/List';
import { DIVIDER, showOptions } from '../components/Overlays';
import { EmojiText } from '../components/RichText';
import { ActionRow, Row, RowList } from '../components/RowList';
import { Screen } from '../components/Screen';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { toast } from '../components/Toast';
import { fmtTime } from '../data/format';
import * as store from '../data/store';
import type { Conversation } from '../data/types';
import { APP_NAME, S } from '../strings';
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
        {conv.muted && <Icon name="mute" class="meta-icon" />}
        {fmtTime(conv.lastTs)}
      </>
    ),
    sub: t ? (
      <span class="typing">{S.typingNow}</span>
    ) : conv.draft ? (
      <>
        <span class="draft-label">{S.draft}</span> <EmojiText text={conv.draft} />
      </>
    ) : (
      <EmojiText text={conv.lastPreview || ''} />
    ),
    badge: <Badge count={conv.unread} />,
    action: S.open,
    onSelect: () => openChat(conv.id),
  };
}

function homeOptions(conv: Conversation | undefined): void {
  showOptions([
    conv && { label: S.chatSettings, onSelect: () => router.push(ChatSettingsScreen, { convId: conv.id }) },
    conv && { label: conv.pinned ? S.unpinChat : S.pinChat, onSelect: () => store.setConvPinned(conv.id, !conv.pinned) || toast(S.pinLimit) },
    conv && { label: S.archive, onSelect: () => store.setArchived(conv.id, true) },
    conv && { label: conv.muted ? S.unmute : S.muteNotifications, onSelect: () => store.setMuted(conv.id, !conv.muted) },
    DIVIDER,
    { label: S.markAllRead, onSelect: () => store.markAllRead() },
    DIVIDER,
    { label: S.search, onSelect: () => router.push(SearchScreen, {}) },
    { label: S.settings, onSelect: () => router.push(SettingsScreen, {}) },
  ]);
}

/** The chat list. Archived chats sit behind a row at the bottom, as in Signal for Android. */
export function HomeScreen() {
  useStoreEvents(['conversations', 'typing']);
  const list = store.conversations();
  const archivedCount = store.archivedConversations().length;
  const rows: Row[] = list.map((c) => convRow(c, false));
  if (archivedCount)
    rows.push({ key: ARCHIVED_ROW, label: S.archivedChats, icon: 'archive', meta: String(archivedCount), action: S.open, onSelect: () => router.push(ArchivedScreen, {}) });

  const empty = !store.isReady() ? <Spinner /> : <EmptyState title={S.noChats} body={S.noChatsHint} />;

  return (
    <Screen title={APP_NAME} banner={<ConnectionBanner />}>
      <RowList
        rows={rows}
        empty={empty}
        softkeys={() => ({ left: S.newChat, right: S.options })}
        onKey={(e, row) => {
          if (e.key === 'SoftLeft') router.push(NewChatScreen, {});
          else if (e.key === 'SoftRight') homeOptions(row && row.key !== ARCHIVED_ROW ? store.conversation(row.key!) : undefined);
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
        empty={<EmptyState title={S.noArchived} body={S.noArchivedHint} />}
        softkeys={(row) => ({ right: row ? S.options : null })}
        onKey={(e, row) => {
          const conv = e.key === 'SoftRight' && row ? store.conversation(row.key!) : undefined;
          if (!conv) return false;
          showOptions([
            { label: S.chatSettings, onSelect: () => router.push(ChatSettingsScreen, { convId: conv.id }) },
            { label: S.unarchive, onSelect: () => store.setArchived(conv.id, false) },
            { label: conv.muted ? S.unmute : S.muteNotifications, onSelect: () => store.setMuted(conv.id, !conv.muted) },
          ]);
          return true;
        }}
      />
    </Screen>
  );
}
