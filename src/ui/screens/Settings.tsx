import { useEffect, useState } from 'preact/hooks';
import { useStoreEvents } from '../app/hooks';
import { router } from '../app/router';
import { setTheme } from '../app/theme';
import { Avatar } from '../components/Avatar';
import { Spinner } from '../components/List';
import { pickEmoji } from '../components/Emoji';
import { confirm, pick, prompt, showOptions } from '../components/Overlays';
import { Row, RowList } from '../components/RowList';
import { Screen } from '../components/Screen';
import { toast } from '../components/Toast';
import { signal, syncedContacts, syncedGroups, unlink, updateProfile } from '../data/api';
import { config, type ThemeName } from '../data/config';
import { db } from '../data/db';
import { EXPIRE_OPTIONS, expireLabel } from '../data/format';
import { appVersion, openUrl } from '../data/platform';
import * as store from '../data/store';
import * as ws from '../data/ws';
import { friendlyError } from '../errors';
import { APP_NAME, S } from '../strings';
import { DebugScreen } from './Debug';
import { LinkScreen } from './Onboarding';
import { QrScreen } from './QrScreen';

export const GUIDE_URL = 'https://github.com/ambercaravalho/signal4kaios/blob/main/docs/user-guide.md';
export const SOURCE_URL = 'https://github.com/ambercaravalho/signal4kaios';

/** Re-render after changing a setting stored outside component state. */
function useRefresh(): () => void {
  const [, set] = useState(0);
  return () => set((n) => n + 1);
}

function selfName(): string {
  const cached = config.profileName();
  if (cached) return cached;
  const me = store.contactByKey(config.number());
  return me && me.name && me.name !== config.number() && me.name !== store.SELF_NAME ? me.name : '';
}

function toggle(key: string, label: string, value: boolean, set: (v: boolean) => void, sub?: string): Row {
  return { key, label, sub, end: 'toggle', checked: value, action: value ? S.turnOff : S.turnOn, onSelect: () => set(!value) };
}

/** Top-level settings, grouped like Signal's. */
export function SettingsScreen() {
  useStoreEvents(['conversations']);
  const name = selfName();
  const uname = config.username();
  const rows: Row[] = [
    { key: 'profile', label: name || S.yourName, sub: uname ? '@' + uname : config.number(), leading: <Avatar conv={{ id: 'profile:' + config.number(), type: 'direct', name: name || config.number() }} />, end: 'chevron', onSelect: () => router.push(ProfileScreen, {}) },
    { section: '' },
    { key: 'linked', label: S.linkedDevice, icon: 'lock', end: 'chevron', onSelect: () => router.push(LinkedDeviceScreen, {}) },
    { key: 'chats', label: S.chatsSection, icon: 'note', end: 'chevron', onSelect: () => router.push(ChatsSettingsScreen, {}) },
    { key: 'privacy', label: S.privacy, icon: 'verified', end: 'chevron', onSelect: () => router.push(PrivacyScreen, {}) },
    { key: 'appearance', label: S.appearance, icon: 'photo', end: 'chevron', onSelect: () => router.push(AppearanceScreen, {}) },
    { key: 'help', label: S.help, icon: 'alert', end: 'chevron', onSelect: () => router.push(HelpScreen, {}) },
    { key: 'debug', label: S.debug, icon: 'file', end: 'chevron', onSelect: () => router.push(DebugScreen, {}) },
  ];
  return (
    <Screen title={S.settings}>
      <RowList rows={rows} />
    </Screen>
  );
}

/** Save the profile, always with a name: Signal rejects a profile without one. */
async function saveProfile(patch: { name?: string; about?: string; emoji?: string }): Promise<void> {
  const name = (patch.name != null ? patch.name : selfName()).trim();
  if (!name) {
    toast(S.nameRequired);
    return;
  }
  const body: { name: string; about?: string; emoji?: string } = { name };
  if (patch.about != null) body.about = patch.about;
  else if (config.profileAbout()) body.about = config.profileAbout();
  if (patch.emoji != null) body.emoji = patch.emoji;
  try {
    await updateProfile(body);
    toast(S.saved);
  } catch (e) {
    toast(friendlyError(e));
  }
}

export function ProfileScreen() {
  const refresh = useRefresh();
  const name = selfName();
  const about = config.profileAbout();
  const emoji = config.profileAboutEmoji();
  const uname = config.username();

  async function chooseEmoji(): Promise<void> {
    const e = await pickEmoji(S.aboutEmoji);
    if (e) saveProfile({ emoji: e }).then(refresh);
  }

  function editEmoji(): void {
    if (!emoji) {
      chooseEmoji();
      return;
    }
    showOptions([
      { label: S.chooseEmoji, onSelect: chooseEmoji },
      { label: S.remove, danger: true, onSelect: () => saveProfile({ emoji: '' }).then(refresh) },
    ]);
  }

  async function editName(): Promise<void> {
    const v = await prompt({ title: S.yourName, value: name, maxLength: 26 });
    if (v) saveProfile({ name: v }).then(refresh);
  }

  async function editAbout(): Promise<void> {
    const v = await prompt({ title: S.about, value: about, maxLength: 140, allowEmpty: true });
    if (v !== undefined) saveProfile({ about: v }).then(refresh);
  }

  async function editUsername(): Promise<boolean> {
    const v = await prompt({ title: S.username, value: uname, hint: S.usernameHint, maxLength: 40 });
    if (!v) return false;
    try {
      const res = await signal.setUsername(v.replace(/^@/, ''));
      toast('@' + res.username);
      refresh();
      return true;
    } catch (e) {
      toast(friendlyError(e, S.usernameTaken));
      return false;
    }
  }

  async function showQr(): Promise<void> {
    if (!config.usernameLink() && !(await editUsername())) return;
    router.push(QrScreen, { title: S.usernameLink, text: config.usernameLink(), caption: '@' + config.username() });
  }

  async function deleteUsername(): Promise<void> {
    if (!(await confirm({ title: S.deleteUsername + '?', body: S.deleteUsernameBody, ok: S.delete, danger: true }))) return;
    signal.deleteUsername().then(
      () => {
        config.set({ username: '', usernameLink: '' });
        toast(S.saved);
        refresh();
      },
      (e) => toast(friendlyError(e))
    );
  }

  const rows: Row[] = [
    { key: 'name', label: S.yourName, sub: name || S.usernameNone, onSelect: editName },
    { key: 'about', label: S.about, sub: about || S.usernameNone, onSelect: editAbout },
    { key: 'emoji', label: S.aboutEmoji, sub: emoji || S.usernameNone, onSelect: editEmoji },
    { key: 'user', label: S.username, sub: uname ? '@' + uname : S.usernameNone, onSelect: editUsername },
    { key: 'qr', label: S.usernameLink, onSelect: showQr },
    !!uname && { key: 'del', label: S.deleteUsername, danger: true, onSelect: deleteUsername },
  ];
  return (
    <Screen title={S.profile}>
      <RowList rows={rows} />
    </Screen>
  );
}

export function LinkedDeviceScreen() {
  const active = config.number();
  const accounts = config.accounts();

  async function doUnlink(): Promise<void> {
    if (!(await confirm({ title: S.unlinkPhone + '?', body: S.unlinkConfirm, ok: S.unlink, danger: true }))) return;
    ws.stop();
    await unlink();
    config.forgetAccount();
    location.reload();
  }

  async function deleteAll(): Promise<void> {
    if (!(await confirm({ title: S.deleteAllData + '?', body: S.deleteAllDataBody, ok: S.delete, danger: true }))) return;
    ws.stop();
    for (const a of config.accounts()) await db.useAccount(a.number).then(() => db.wipe()).catch(() => {});
    await db.useAccount(null).then(() => db.wipe()).catch(() => {});
    config.clear();
    location.reload();
  }

  function sync(): void {
    signal.requestSync().then(
      () => toast(S.syncRequested),
      (e) => toast(friendlyError(e))
    );
  }

  const rows: Row[] = [
    { key: 'as', label: S.linkedAs, sub: [config.number(), config.deviceName()].filter(Boolean).join(' · ') },
    { key: 'sync', label: S.syncNow, onSelect: sync },
    { section: S.accounts },
    ...accounts.map((a) => ({
      key: 'acc:' + a.number,
      label: a.number,
      end: 'radio' as const,
      checked: a.number === active,
      action: S.switchAccount,
      onSelect:
        a.number === active
          ? undefined
          : () => {
              ws.stop();
              config.switchAccount(a.number);
              location.reload();
            },
    })),
    { key: 'add', label: S.addAccount, onSelect: () => router.push(LinkScreen, { mode: 'add' as const }) },
    { section: '' },
    { key: 'unlink', label: S.unlinkPhone, danger: true, onSelect: doUnlink },
    { key: 'wipe', label: S.deleteAllData, danger: true, onSelect: deleteAll },
  ];
  return (
    <Screen title={S.linkedDevice}>
      <RowList rows={rows} />
    </Screen>
  );
}

export function ChatsSettingsScreen() {
  const refresh = useRefresh();
  const rows: Row[] = [
    toggle('fmt', S.textFormatting, config.styledText(), (v) => (config.set({ styledText: v }), refresh()), S.textFormattingHint),
    toggle('muted', S.keepMutedArchived, config.keepMutedArchived(), (v) => (config.set({ keepMutedArchived: v }), refresh())),
  ];
  return (
    <Screen title={S.chatsSection}>
      <RowList rows={rows} />
    </Screen>
  );
}

export function PrivacyScreen() {
  const refresh = useRefresh();
  const defaultTimer = config.defaultExpireTimer();

  async function chooseDefaultTimer(): Promise<void> {
    const secs = await pick(S.defaultTimer, EXPIRE_OPTIONS.map((o) => ({ value: o.secs, label: o.label })), defaultTimer);
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
    toggle('receipts', S.readReceipts, config.sendReadReceipts(), (v) => (config.set({ sendReadReceipts: v }), refresh()), S.readReceiptsHint),
    toggle('typing', S.typingIndicators, config.typingIndicators(), (v) => (config.set({ typingIndicators: v }), refresh()), S.typingIndicatorsHint),
    { key: 'timer', label: S.defaultTimer, sub: expireLabel(defaultTimer), onSelect: chooseDefaultTimer },
    toggle('private', S.privateDeliveryIcon, config.sealedSenderIndicators(), setPrivateIcon, S.privateDeliveryHint),
    { key: 'phone', label: S.phoneNumber, end: 'chevron', onSelect: () => router.push(PhoneNumberScreen, {}) },
    { key: 'blocked', label: S.blockedPeople, end: 'chevron', onSelect: () => router.push(BlockedScreen, {}) },
  ];
  return (
    <Screen title={S.privacy}>
      <RowList rows={rows} />
    </Screen>
  );
}

/** Who sees and who can find you by your number, as in Signal: a number everybody sees can always be found. */
export function PhoneNumberScreen() {
  const refresh = useRefresh();
  const share = config.sharePhoneNumber();
  const findable = config.findableByNumber();
  const label = (on: boolean) => (on ? S.everybody : S.nobody);

  function save(nextShare: boolean, nextFindable: boolean): void {
    config.set({ sharePhoneNumber: nextShare, findableByNumber: nextShare || nextFindable });
    refresh();
    signal.setPhoneNumberPrivacy(nextShare, nextFindable).catch((e) => {
      config.set({ sharePhoneNumber: share, findableByNumber: findable });
      refresh();
      toast(friendlyError(e));
    });
  }

  async function choose(title: string, nobodyHint: string, current: boolean, apply: (v: boolean) => void): Promise<void> {
    const v = await pick(title, [{ value: true, label: S.everybody }, { value: false, label: S.nobody, sub: nobodyHint }], current);
    if (v !== undefined && v !== current) apply(v);
  }

  const rows: Row[] = [
    { key: 'see', label: S.whoCanSeeNumber, sub: label(share), onSelect: () => choose(S.whoCanSeeNumber, S.seeNumberHint, share, (v) => save(v, v || findable)) },
    {
      key: 'find',
      label: S.whoCanFindNumber,
      sub: label(findable),
      onSelect: () => (share ? toast(S.findLocked) : choose(S.whoCanFindNumber, S.findNumberHint, findable, (v) => save(false, v))),
    },
  ];
  return (
    <Screen title={S.phoneNumber}>
      <RowList rows={rows} />
    </Screen>
  );
}

export function AppearanceScreen() {
  const refresh = useRefresh();
  const theme = config.theme();
  async function choose(): Promise<void> {
    const t = await pick<ThemeName>(S.theme, [{ value: 'light', label: S.light }, { value: 'dark', label: S.dark }], theme);
    if (t) {
      setTheme(t);
      refresh();
    }
  }
  return (
    <Screen title={S.appearance}>
      <RowList rows={[{ key: 'theme', label: S.theme, sub: theme === 'dark' ? S.dark : S.light, onSelect: choose }]} />
    </Screen>
  );
}

export function HelpScreen() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    appVersion().then(setVersion);
  }, []);
  const open = (url: string) => () => openUrl(url).catch(() => toast(S.errGeneric));
  return (
    <Screen title={S.help}>
      <RowList
        rows={[
          { key: 'ver', label: APP_NAME, sub: S.version + ' ' + (version || '…') },
          { key: 'guide', label: S.userGuide, onSelect: open(GUIDE_URL) },
          { key: 'src', label: S.sourceCode, onSelect: open(SOURCE_URL) },
          { key: 'about', label: S.unofficialTitle, sub: S.unofficial },
        ]}
      />
    </Screen>
  );
}

interface BlockedEntry {
  kind: 'contact' | 'group';
  id: string;
  name: string;
  sub: string;
}

export function BlockedScreen() {
  const [list, setList] = useState<BlockedEntry[] | null>(null);
  const load = () =>
    Promise.all([syncedContacts(), syncedGroups()]).then(([cs, gs]) =>
      setList(
        cs
          .filter((c) => c.blocked)
          .map((c): BlockedEntry => ({ kind: 'contact', id: c.uuid || c.number, name: store.contactName(c) || c.number || S.unknown, sub: c.number || '' }))
          .concat(gs.filter((g) => g.blocked).map((g): BlockedEntry => ({ kind: 'group', id: g.id, name: g.name || S.group, sub: S.group })))
      )
    );
  useEffect(() => {
    load();
  }, []);

  async function unblock(e: BlockedEntry): Promise<void> {
    if (!(await confirm({ title: S.unblock + ' ' + e.name + '?', body: e.kind === 'group' ? S.unblockGroupBody : S.unblockBody, ok: S.unblock }))) return;
    const p = e.kind === 'group' ? signal.setGroupBlocked(e.id, false) : signal.setContactBlocked(e.id, false);
    p.then(
      () => {
        toast(S.unblocked);
        load();
      },
      (err) => toast(friendlyError(err))
    );
  }

  return (
    <Screen title={S.blockedPeople}>
      {list === null ? (
        <Spinner />
      ) : (
        <RowList
          rows={list.map((e) => ({ key: e.kind + e.id, label: e.name, sub: e.sub, action: S.unblock, onSelect: () => unblock(e) }))}
          empty={<div class="empty">{S.noBlocked}</div>}
        />
      )}
    </Screen>
  );
}
