import { useRefresh } from '../../app/hooks';
import { Row, RowList } from '../../components/RowList';
import { Screen } from '../../components/Screen';
import { toggleRow } from '../../components/setting-rows';
import { toast } from '../../components/Toast';
import { signal } from '../../data/api';
import { config } from '../../data/config';
import { friendlyError } from '../../errors';
import { S } from '../../strings';

export function ChatsSettingsScreen() {
  const refresh = useRefresh();
  const rows: Row[] = [
    toggleRow('fmt', S.textFormatting, config.styledText(), (v) => (config.set({ styledText: v }), refresh()), S.textFormattingHint),
    toggleRow('muted', S.keepMutedArchived, config.keepMutedArchived(), (v) => (config.set({ keepMutedArchived: v }), refresh())),
    toggleRow('previews', S.generateLinkPreviews, config.linkPreviews(), setLinkPreviews, S.generateLinkPreviewsHint),
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
