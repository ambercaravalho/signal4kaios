import { useStoreEvents } from '../app/hooks';
import { router } from '../app/router';
import { Avatar, OWN_PROFILE_PREFIX } from '../components/Avatar';
import { Row, RowList } from '../components/RowList';
import { Screen } from '../components/Screen';
import { config } from '../data/config';
import { availableUpdate } from '../data/updates';
import { S } from '../strings';
import { DebugScreen } from './Debug';
import { AboutScreen } from './settings/About';
import { AppearanceScreen } from './settings/Appearance';
import { ChatsSettingsScreen } from './settings/Chats';
import { HelpScreen } from './settings/Help';
import { LinkedDeviceScreen } from './settings/LinkedDevice';
import { NotificationsScreen } from './settings/Notifications';
import { PrivacyScreen } from './settings/Privacy';
import { ProfileScreen, selfName } from './settings/Profile';
import { updateRow } from './settings/Updates';

export { ProfileScreen } from './settings/Profile';
export { deleteAllData, LinkedDeviceScreen } from './settings/LinkedDevice';
export { ChatsSettingsScreen } from './settings/Chats';
export { NotificationsScreen } from './settings/Notifications';
export { PrivacyScreen } from './settings/Privacy';
export { lockAfterLabel, pinWaitMessage, ScreenLockScreen } from './settings/ScreenLock';
export { PhoneNumberScreen } from './settings/PhoneNumber';
export { AppearanceScreen } from './settings/Appearance';
export { HelpScreen } from './settings/Help';
export { AboutScreen } from './settings/About';
export { BlockedScreen } from './settings/Blocked';
export { updateMenuItem } from './settings/Updates';

/** Top-level settings, grouped like Signal's. */
export function SettingsScreen() {
  useStoreEvents(['conversations', 'update']);
  const name = selfName();
  const uname = config.username();
  const update = availableUpdate();
  const rows: Row[] = [
    { key: 'profile', label: name || S.yourName, sub: uname ? '@' + uname : config.number(), leading: <Avatar conv={{ id: OWN_PROFILE_PREFIX + config.number(), type: 'direct', name: name || config.number() }} />, end: 'chevron', onSelect: () => router.push(ProfileScreen, {}) },
    update && { section: '' },
    update && updateRow(),
    { section: '' },
    { key: 'linked', label: S.linkedDevice, icon: 'lock', end: 'chevron', onSelect: () => router.push(LinkedDeviceScreen, {}) },
    { key: 'chats', label: S.chatsSection, icon: 'chat', end: 'chevron', onSelect: () => router.push(ChatsSettingsScreen, {}) },
    { key: 'notifications', label: S.notifications, icon: 'bell', end: 'chevron', onSelect: () => router.push(NotificationsScreen, {}) },
    { key: 'privacy', label: S.privacy, icon: 'verified', end: 'chevron', onSelect: () => router.push(PrivacyScreen, {}) },
    { key: 'appearance', label: S.appearance, icon: 'photo', end: 'chevron', onSelect: () => router.push(AppearanceScreen, {}) },
    { key: 'help', label: S.help, icon: 'help', end: 'chevron', onSelect: () => router.push(HelpScreen, {}) },
    { key: 'debug', label: S.debug, icon: 'file', end: 'chevron', onSelect: () => router.push(DebugScreen, {}) },
    { key: 'about', label: S.aboutApp, icon: 'info', end: 'chevron', onSelect: () => router.push(AboutScreen, {}) },
  ];
  return (
    <Screen title={S.settings}>
      <RowList rows={rows} />
    </Screen>
  );
}
