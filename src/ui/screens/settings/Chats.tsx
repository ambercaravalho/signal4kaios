import { useRefresh } from '../../app/hooks';
import { router } from '../../app/router';
import { Row, RowList } from '../../components/RowList';
import { Screen } from '../../components/Screen';
import { toggleRow } from '../../components/setting-rows';
import { toast } from '../../components/Toast';
import { signal } from '../../data/api';
import { config } from '../../data/config';
import { foldersInOrder } from '../../data/store';
import { friendlyError } from '../../errors';
import { plural, S } from '../../strings';
import { guideRow } from '../Guide';
import { ChatFoldersScreen } from './ChatFolders';

export function ChatsSettingsScreen() {
  const refresh = useRefresh();
  const rows: Row[] = [
    toggleRow('fmt', S.textFormatting, config.styledText(), (v) => (config.set({ styledText: v }), refresh()), S.textFormattingHint),
    toggleRow('muted', S.keepMutedArchived, config.keepMutedArchived(), (v) => (config.set({ keepMutedArchived: v }), refresh())),
    toggleRow('previews', S.generateLinkPreviews, config.linkPreviews(), setLinkPreviews, S.generateLinkPreviewsHint),
    { section: '' },
    { key: 'folders', label: S.chatFolders, sub: config.chatFolders().length ? plural(foldersInOrder().length, S.folderOne, S.folderMany) : undefined, action: S.open, onSelect: () => router.push(ChatFoldersScreen, {}) },
    { section: '' },
    guideRow('settings'),
  ];

  function setLinkPreviews(on: boolean): void {
    config.set({ linkPreviews: on });
    refresh();
    signal.setLinkPreviews(on).catch((e) => toast(friendlyError(e)));
  }
  return (
    <Screen title={S.chatsSection}>
      <RowList rows={rows} />
    </Screen>
  );
}
