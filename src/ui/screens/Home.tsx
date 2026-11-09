import { useState } from 'preact/hooks';
import { useStoreEvents } from '../app/hooks';
import { router } from '../app/router';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { Badge, EmptyState, Spinner } from '../components/List';
import { showOptions } from '../components/Overlays';
import { EmojiText } from '../components/RichText';
import { ActionRow, RowList } from '../components/RowList';
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

function convRow(conv: Conversation, archivedTab: boolean): ActionRow {
  const t = !archivedTab && store.typing(conv.id);
  return {
    key: conv.id,
    label: conv.name || S.unknown,
    leading: <Avatar conv={conv} />,
    meta: (
      <>
        {conv.pinned && !archivedTab && <Icon name="pin" class="meta-icon" />}
        {conv.muted && <Icon name="mute" class="meta-icon" />}
        {fmtTime(conv.lastTs)}
      </>
    ),
    sub: t ? <span class="typing">{S.typingNow}</span> : <EmojiText text={conv.lastPreview || ''} />,
    badge: <Badge count={conv.unread} />,
    action: S.open,
    onSelect: () => openChat(conv.id),
  };
}

function chatOptions(conv: Conversation | undefined, archivedTab: boolean): void {
  showOptions([
    conv && { label: S.chatSettings, onSelect: () => router.push(ChatSettingsScreen, { convId: conv.id }) },
    conv && !archivedTab && { label: conv.pinned ? S.unpinChat : S.pinChat, onSelect: () => store.setConvPinned(conv.id, !conv.pinned) || toast(S.pinLimit) },
    conv && { label: conv.archived ? S.unarchive : S.archive, onSelect: () => store.setArchived(conv.id, !conv.archived) },
    conv && { label: conv.muted ? S.unmute : S.muteNotifications, onSelect: () => store.setMuted(conv.id, !conv.muted) },
    !archivedTab && { label: S.markAllRead, onSelect: () => store.markAllRead() },
    { label: S.search, onSelect: () => router.push(SearchScreen, {}) },
    { label: S.settings, onSelect: () => router.push(SettingsScreen, {}) },
  ]);
}

/** The chat list, with Chats and Archived tabs. */
export function HomeScreen() {
  useStoreEvents(['conversations', 'typing']);
  const [tab, setTab] = useState(0);
  const archivedTab = tab === 1;
  const list = archivedTab ? store.archivedConversations() : store.conversations();

  const empty = !store.isReady() ? <Spinner /> : archivedTab ? <EmptyState title={S.noArchived} body={S.noArchivedHint} /> : <EmptyState title={S.noChats} body={S.noChatsHint} />;

  return (
    <Screen title={APP_NAME} tabs={{ labels: [S.chats, S.archived], index: tab, onChange: setTab }} banner={<ConnectionBanner />}>
      <RowList
        key={tab}
        rows={list.map((c) => convRow(c, archivedTab))}
        empty={empty}
        softkeys={() => ({ left: archivedTab ? null : S.newChat, right: S.options })}
        onKey={(e, row) => {
          if (e.key === 'SoftLeft' && !archivedTab) router.push(NewChatScreen, {});
          else if (e.key === 'SoftRight') chatOptions(row ? store.conversation(row.key!) : undefined, archivedTab);
          else return false;
          return true;
        }}
      />
    </Screen>
  );
}
