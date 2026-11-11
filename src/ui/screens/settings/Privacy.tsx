import { useRefresh } from '../../app/hooks';
import { router, useOnResume } from '../../app/router';
import { Row, RowList } from '../../components/RowList';
import { Screen } from '../../components/Screen';
import { pickTimer, toggleRow } from '../../components/setting-rows';
import { toast } from '../../components/Toast';
import { signal } from '../../data/api';
import { config } from '../../data/config';
import { expireLabel } from '../../data/format';
import { activeProxy } from '../../data/proxy';
import * as screenLock from '../../data/screen-lock';
import { friendlyError } from '../../errors';
import { S } from '../../strings';
import { ProxyScreen } from '../Proxy';
import { BlockedScreen } from './Blocked';
import { PhoneNumberScreen } from './PhoneNumber';
import { lockAfterLabel, ScreenLockScreen } from './ScreenLock';

export function PrivacyScreen() {
  const refresh = useRefresh();
  const defaultTimer = config.defaultExpireTimer();

  async function chooseDefaultTimer(): Promise<void> {
    const secs = await pickTimer(S.defaultTimer, defaultTimer);
    if (secs === undefined || secs === defaultTimer) return;
    config.set({ defaultExpireTimer: secs });
    refresh();
    signal.setUniversalExpireTimer(secs).catch((e) => toast(friendlyError(e)));
  }

  function setPrivateIcon(on: boolean): void {
    config.set({ sealedSenderIndicators: on });
    refresh();
    signal.setSealedSenderIndicators(on).catch((e) => toast(friendlyError(e)));
  }

  const rows: Row[] = [
    toggleRow('receipts', S.readReceipts, config.sendReadReceipts(), (v) => (config.set({ sendReadReceipts: v }), refresh()), S.readReceiptsHint),
    toggleRow('typing', S.typingIndicators, config.typingIndicators(), (v) => (config.set({ typingIndicators: v }), refresh()), S.typingIndicatorsHint),
    { key: 'timer', label: S.defaultTimer, sub: expireLabel(defaultTimer), onSelect: chooseDefaultTimer },
    toggleRow('private', S.privateDeliveryIcon, config.sealedSenderIndicators(), setPrivateIcon, S.privateDeliveryHint),
    { key: 'phone', label: S.phoneNumber, end: 'chevron', onSelect: () => router.push(PhoneNumberScreen, {}) },
    { key: 'lock', label: S.screenLock, sub: screenLock.enabled() ? lockAfterLabel(screenLock.lockAfter()) : undefined, end: 'chevron', onSelect: () => router.push(ScreenLockScreen, {}) },
    { key: 'blocked', label: S.blockedPeople, end: 'chevron', onSelect: () => router.push(BlockedScreen, {}) },
    { key: 'proxy', label: S.proxy, sub: activeProxy() || undefined, end: 'chevron', onSelect: () => router.push(ProxyScreen, {}) },
  ];
  useOnResume(refresh);
  return (
    <Screen title={S.privacy}>
      <RowList rows={rows} />
    </Screen>
  );
}
