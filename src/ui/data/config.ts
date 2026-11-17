/* Account and app settings in localStorage (`s4k.config`). The active account's credentials sit at the top level; `accounts` holds every saved account so the user can switch, and each account has its own IndexedDB. */

import type { HostChatFolder, HostNotificationProfile, HostProfileOverride, HostStickerPack } from '../../engine/host';

const KEY = 's4k.config';
const DEFAULT_SIGNAL_SERVER = 'https://chat.signal.org';

/** SECURITY-REVIEW: `deviceToken` is the account's device password, kept in this app's localStorage; it is never logged or shown. */
export interface SavedAccount {
  number: string;
  /** The number the account's database was created under; IndexedDB can't rename it after a number change. */
  dbNumber?: string;
  aci: string;
  deviceId: number;
  serverUrl: string;
  deviceToken: string;
}

export type ThemeName = 'light' | 'dark';

export type TextSize = 'small' | 'normal' | 'large' | 'xlarge';
const TEXT_SIZES: TextSize[] = ['small', 'normal', 'large', 'xlarge'];

/** A notification shows the sender and message, the sender only, or neither. */
export type NotifyShow = 'all' | 'name' | 'none';

/** The screen lock PIN's salted hash, how long the app may sit in the background before locking, and the wrong-PIN count. */
export interface ScreenLockConfig {
  salt: string;
  hash: string;
  iterations: number;
  lockAfter: number;
  failures: number;
  /** What's left of the wait after wrong PINs, counted down only while the app runs. */
  waitLeftMs: number;
}

/** Message history the phone offered when this account was linked, until it is imported or skipped. `chunks` were downloaded so far; `downloaded` once the whole archive is in. */
export interface HistorySync {
  aci: string;
  /** SECURITY-REVIEW: the ephemeral backup key (base64) that decrypts the archive; dropped once the import ends. */
  key: string;
  archive?: { cdn: number; key: string };
  chunks?: number;
  downloaded?: boolean;
}

interface ConfigData {
  serverUrl?: string;
  number?: string;
  dbNumber?: string;
  aci?: string;
  deviceId?: number;
  deviceToken?: string;
  deviceName?: string;
  username?: string;
  usernameLink?: string;
  profileName?: string;
  profileAbout?: string;
  profileAboutEmoji?: string;
  theme?: ThemeName;
  sendReadReceipts?: boolean;
  styledText?: boolean;
  typingIndicators?: boolean;
  linkPreviews?: boolean;
  sealedSenderIndicators?: boolean;
  /** Seconds; the disappearing-message timer new 1:1 chats start with. */
  defaultExpireTimer?: number;
  keepMutedArchived?: boolean;
  /** The account's quick reactions from Storage Service, in order; an empty slot uses Signal's default. */
  reactionEmoji?: string[];
  /** The account's defaults for muted chats and reactions, shared through Storage Service. */
  notifyMentionsIfMuted?: boolean;
  notifyRepliesIfMuted?: boolean;
  notifyCallsIfMuted?: boolean;
  notifyReactions?: boolean;
  /** What a notification shows, on this phone only. */
  notifyShow?: NotifyShow;
  notifySound?: boolean;
  /** Notification profiles from the phone, through Storage Service. */
  notificationProfiles?: HostNotificationProfile[];
  notificationProfileOverride?: HostProfileOverride;
  chatFolders?: HostChatFolder[];
  stickerPacks?: HostStickerPack[];
  textSize?: TextSize;
  /** The bubble color chats use unless they have their own; on this phone only. */
  chatColor?: string;
  sharePhoneNumber?: boolean;
  findableByNumber?: boolean;
  screenLock?: ScreenLockConfig;
  proxyAddress?: string;
  proxyEnabled?: boolean;
  accounts?: SavedAccount[];
  /** When each account (by ACI) last checked its PreKeys on the server. */
  preKeysCheckedAt?: Record<string, number>;
  /** Every database Beacon has opened on this phone, so Delete all data can find them where the browser can't list them. */
  knownDatabases?: string[];
  /** Each account's database key (`dbNumber`) by ACI, kept after an unlink so relinking with a new number finds its history. */
  accountDatabases?: Record<string, string>;
  /** Why the Link screen is asking to link again. */
  relinkReason?: RelinkReason;
  autoUpdateCheck?: boolean;
  /** When Beacon last asked for a newer release. */
  updateCheckedAt?: number;
  /** The newest version a security notification was already shown for. */
  updateNotified?: string;
  /** The version that ran last, so the first launch after an update can say so. */
  lastRunVersion?: string;
  /** The `ACCOUNT_KEYS` settings of each saved account (by ACI) other than the active one, whose settings are at the top level. */
  accountSettings?: Record<string, Partial<ConfigData>>;
  [k: string]: unknown;
}

/** `unlinked`: the main phone or Signal removed this phone; `here`: it was unlinked in Settings; `keys`: its keys on this phone were lost; `history`: the main phone asked to link again for history. */
export type RelinkReason = 'unlinked' | 'here' | 'keys' | 'history';

/** Settings that belong to one Signal account: its profile, what Storage Service shares with its other devices, and its pending history. The rest belong to the phone. */
const ACCOUNT_KEYS = [
  'deviceName',
  'username',
  'usernameLink',
  'profileName',
  'profileAbout',
  'profileAboutEmoji',
  'sendReadReceipts',
  'typingIndicators',
  'linkPreviews',
  'sealedSenderIndicators',
  'defaultExpireTimer',
  'keepMutedArchived',
  'reactionEmoji',
  'sharePhoneNumber',
  'findableByNumber',
  'notifyMentionsIfMuted',
  'notifyRepliesIfMuted',
  'notifyCallsIfMuted',
  'notifyReactions',
  'notificationProfiles',
  'notificationProfileOverride',
  'chatFolders',
  'stickerPacks',
  'historySync',
] as const;

/** Moves the active account's settings into `accountSettings` and brings `aci`'s back (or the defaults for an account seen for the first time). */
function swapAccountSettings(c: ConfigData, aci: string, keepActive: boolean): void {
  const saved = Object.assign({}, c.accountSettings);
  if (keepActive && c.aci) {
    const mine: Partial<ConfigData> = {};
    for (const k of ACCOUNT_KEYS) if (c[k] !== undefined) mine[k] = c[k] as never;
    saved[c.aci] = mine;
  }
  for (const k of ACCOUNT_KEYS) delete c[k];
  Object.assign(c, saved[aci] || {});
  delete saved[aci];
  c.accountSettings = saved;
}

function read(): ConfigData {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null') || {};
  } catch {
    return {};
  }
}

function write(c: ConfigData): void {
  localStorage.setItem(KEY, JSON.stringify(c));
}

type StringKey = 'number' | 'aci' | 'deviceToken' | 'deviceName' | 'username' | 'usernameLink' | 'profileName' | 'profileAbout' | 'profileAboutEmoji' | 'proxyAddress';
type FlagKey =
  | 'sendReadReceipts'
  | 'styledText'
  | 'typingIndicators'
  | 'linkPreviews'
  | 'sealedSenderIndicators'
  | 'keepMutedArchived'
  | 'notifyMentionsIfMuted'
  | 'notifyRepliesIfMuted'
  | 'notifyCallsIfMuted'
  | 'notifyReactions'
  | 'notifySound'
  | 'sharePhoneNumber'
  | 'proxyEnabled'
  | 'autoUpdateCheck';

const text = (k: StringKey) => (): string => {
  const v = read()[k];
  return typeof v === 'string' ? v : '';
};
/** A setting that is on unless turned off, like most of Signal's. */
const onUnlessOff = (k: FlagKey) => (): boolean => read()[k] !== false;
const offUnlessOn = (k: FlagKey) => (): boolean => read()[k] === true;

export const config = {
  set(patch: Partial<ConfigData>): void {
    write(Object.assign(read(), patch));
  },

  serverUrl(): string {
    return (read().serverUrl || DEFAULT_SIGNAL_SERVER).replace(/\/+$/, '');
  },

  wsUrl(): string {
    return config.serverUrl().replace(/^http/, 'ws');
  },

  number: text('number'),

  /** The number naming the active account's database. */
  dbNumber(): string {
    const c = read();
    return c.dbNumber || c.number || '';
  },

  aci: text('aci'),

  deviceId(): number {
    return read().deviceId || 0;
  },

  /** The linked device's Signal password. Never logged. */
  deviceToken: text('deviceToken'),
  deviceName: text('deviceName'),
  username: text('username'),
  usernameLink: text('usernameLink'),
  profileName: text('profileName'),
  profileAbout: text('profileAbout'),
  profileAboutEmoji: text('profileAboutEmoji'),

  theme(): ThemeName {
    return read().theme === 'dark' ? 'dark' : 'light';
  },

  sendReadReceipts: onUnlessOff('sendReadReceipts'),
  styledText: onUnlessOff('styledText'),
  typingIndicators: onUnlessOff('typingIndicators'),
  linkPreviews: onUnlessOff('linkPreviews'),
  sealedSenderIndicators: offUnlessOn('sealedSenderIndicators'),

  reactionEmoji(): string[] {
    const v = read().reactionEmoji;
    return Array.isArray(v) ? v.map((e) => (typeof e === 'string' ? e : '')) : [];
  },

  defaultExpireTimer(): number {
    const v = read().defaultExpireTimer;
    return typeof v === 'number' && v > 0 ? Math.floor(v) : 0;
  },

  /** Whether everybody sees our number; Signal defaults to nobody. */
  sharePhoneNumber: offUnlessOn('sharePhoneNumber'),

  findableByNumber(): boolean {
    return config.sharePhoneNumber() || read().findableByNumber !== false;
  },

  /** Muted chats stay archived when new messages arrive, as in Signal. */
  keepMutedArchived: onUnlessOff('keepMutedArchived'),
  /** In muted chats, mentions and replies to us notify unless turned off and calls only if turned on, as in Signal. */
  notifyMentionsIfMuted: onUnlessOff('notifyMentionsIfMuted'),
  notifyRepliesIfMuted: onUnlessOff('notifyRepliesIfMuted'),
  notifyCallsIfMuted: offUnlessOn('notifyCallsIfMuted'),
  notifyReactions: onUnlessOff('notifyReactions'),
  notifySound: onUnlessOff('notifySound'),

  notifyShow(): NotifyShow {
    const v = read().notifyShow;
    return v === 'name' || v === 'none' ? v : 'all';
  },

  notificationProfiles(): HostNotificationProfile[] {
    const v = read().notificationProfiles;
    return Array.isArray(v) ? v.filter((p) => p && typeof p.id === 'string' && Array.isArray(p.allowed)) : [];
  },

  /** Chat folders from Storage Service, in display order. */
  chatFolders(): HostChatFolder[] {
    const v = read().chatFolders;
    return Array.isArray(v) ? v.filter((f) => f && typeof f.id === 'string' && Array.isArray(f.included) && Array.isArray(f.excluded)) : [];
  },

  /** Installed sticker packs from Storage Service and the phone; kept for a later sticker picker. */
  stickerPacks(): HostStickerPack[] {
    const v = read().stickerPacks;
    return Array.isArray(v) ? v.filter((p) => p && typeof p.id === 'string' && typeof p.key === 'string') : [];
  },

  notificationProfileOverride(): HostProfileOverride {
    const v = read().notificationProfileOverride;
    return v && typeof v === 'object' ? v : null;
  },

  /** Text size on this phone only. */
  textSize(): TextSize {
    const v = read().textSize;
    return v && TEXT_SIZES.indexOf(v) >= 0 ? v : 'normal';
  },

  /** The default chat color's name, or '' for automatic; check it with `isChatColor`. */
  chatColor(): string {
    const v = read().chatColor;
    return typeof v === 'string' ? v : '';
  },

  /** The Signal proxy's hostname, kept while the proxy is turned off. */
  proxyAddress: text('proxyAddress'),
  proxyEnabled: offUnlessOn('proxyEnabled'),

  /** Look for a newer Beacon about once a day; on this phone only. */
  autoUpdateCheck: onUnlessOff('autoUpdateCheck'),

  updateCheckedAt(): number {
    const v = read().updateCheckedAt;
    return typeof v === 'number' && v > 0 ? v : 0;
  },

  updateNotified(): string {
    const v = read().updateNotified;
    return typeof v === 'string' ? v : '';
  },

  lastRunVersion(): string {
    const v = read().lastRunVersion;
    return typeof v === 'string' ? v : '';
  },

  screenLock(): ScreenLockConfig | null {
    const s = read().screenLock;
    if (!s || typeof s.salt !== 'string' || typeof s.hash !== 'string' || !(s.iterations > 0)) return null;
    return {
      salt: s.salt,
      hash: s.hash,
      iterations: s.iterations,
      lockAfter: typeof s.lockAfter === 'number' && s.lockAfter >= 0 ? s.lockAfter : 60,
      failures: typeof s.failures === 'number' && s.failures > 0 ? s.failures : 0,
      waitLeftMs: typeof s.waitLeftMs === 'number' && s.waitLeftMs > 0 ? Math.min(s.waitLeftMs, 15 * 60000) : 0,
    };
  },

  /** The active account's pending message history, if any. */
  historySync(): HistorySync | null {
    const h = read().historySync as HistorySync | undefined;
    return h && typeof h.key === 'string' && h.key && h.aci === config.aci() ? h : null;
  },

  setHistorySync(h: HistorySync | null): void {
    const c = read();
    if (h) c.historySync = h;
    else delete c.historySync;
    write(c);
  },

  isConfigured(): boolean {
    const c = read();
    return !!((c.number || c.aci) && c.deviceToken && c.deviceId);
  },

  /** The Basic auth login, `<aci or number>.<deviceId>`. */
  login(): string {
    return (config.aci() || config.number()) + '.' + config.deviceId();
  },

  accounts(): SavedAccount[] {
    return read().accounts || [];
  },

  /** Insert or update the active account in the saved list. SECURITY-REVIEW: copies the device password into the saved account. */
  saveActiveAccount(): void {
    const c = read();
    const list = c.accounts || [];
    const entry: SavedAccount = {
      number: c.number || '',
      dbNumber: c.dbNumber || c.number || '',
      aci: c.aci || '',
      deviceId: c.deviceId || 0,
      serverUrl: c.serverUrl || DEFAULT_SIGNAL_SERVER,
      deviceToken: c.deviceToken || '',
    };
    const i = list.findIndex((a) => (!!entry.aci && a.aci === entry.aci) || a.number === entry.number);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    c.accounts = list;
    if (entry.aci && entry.dbNumber) c.accountDatabases = Object.assign({}, c.accountDatabases, { [entry.aci]: entry.dbNumber });
    write(c);
  },

  /** The key of the database the account with `aci` already has on this phone, else `number`; a relink after a number change opens the old one. */
  dbKeyFor(aci: string, number: string): string {
    const c = read();
    if (aci) {
      const known = c.accountDatabases && c.accountDatabases[aci];
      if (typeof known === 'string' && known) return known;
      if (c.aci === aci && (c.dbNumber || c.number)) return (c.dbNumber || c.number) as string;
      const a = (c.accounts || []).find((x) => x.aci === aci);
      if (a && (a.dbNumber || a.number)) return a.dbNumber || a.number;
    }
    return number || aci;
  },

  /** The active account has a new number; its database keeps the name it was created under. */
  changeNumber(number: string): void {
    const c = read();
    if (!number || number === c.number) return;
    c.dbNumber = c.dbNumber || c.number || '';
    c.number = number;
    write(c);
    if ((c.accounts || []).some((a) => (!!c.aci && a.aci === c.aci) || a.number === c.dbNumber)) config.saveActiveAccount();
  },

  /** Drop the active account's device credentials, after unlinking or a 401; `reason` is what the Link screen says. */
  forgetAccount(reason: RelinkReason = 'unlinked'): void {
    const c = read();
    c.relinkReason = reason;
    const num = c.number;
    const aci = c.aci;
    c.deviceToken = '';
    c.deviceId = 0;
    if (aci && (c.dbNumber || num)) c.accountDatabases = Object.assign({}, c.accountDatabases, { [aci]: c.dbNumber || num });
    c.accounts = (c.accounts || []).filter((a) => a.number !== num && (!aci || a.aci !== aci));
    write(c);
  },

  relinkReason(): RelinkReason {
    const v = read().relinkReason;
    return v === 'here' || v === 'keys' || v === 'history' ? v : 'unlinked';
  },

  knownDatabases(): string[] {
    const v = read().knownDatabases;
    return Array.isArray(v) ? v.filter((n) => typeof n === 'string') : [];
  },

  noteDatabase(name: string): void {
    const c = read();
    const list = Array.isArray(c.knownDatabases) ? c.knownDatabases : [];
    if (list.indexOf(name) >= 0) return;
    c.knownDatabases = list.concat([name]);
    write(c);
  },

  /** Before a newly linked account's credentials are saved: put the active account's settings aside and start `aci` with its own (relinking the active account keeps them). */
  prepareAccount(aci: string): void {
    const c = read();
    if (!aci || c.aci === aci) return;
    swapAccountSettings(c, aci, (c.accounts || []).some((a) => !!c.aci && a.aci === c.aci));
    write(c);
  },

  preKeysCheckedAt(): number {
    const c = read();
    const at = c.preKeysCheckedAt && c.aci ? c.preKeysCheckedAt[c.aci] : 0;
    return typeof at === 'number' ? at : 0;
  },

  setPreKeysCheckedAt(at: number): void {
    const c = read();
    if (!c.aci) return;
    c.preKeysCheckedAt = Object.assign({}, c.preKeysCheckedAt, { [c.aci]: at });
    write(c);
  },

  /** Make a saved account active, with its own settings. The caller reloads so the right database and connection are used. SECURITY-REVIEW: moves the saved device password back to the active account. */
  switchAccount(number: string): boolean {
    const c = read();
    const a = (c.accounts || []).find((x) => x.number === number);
    if (!a) return false;
    if (a.aci !== c.aci) swapAccountSettings(c, a.aci, (c.accounts || []).some((x) => !!c.aci && x.aci === c.aci));
    c.serverUrl = a.serverUrl || DEFAULT_SIGNAL_SERVER;
    c.number = a.number || '';
    c.dbNumber = a.dbNumber || a.number || '';
    c.aci = a.aci || '';
    c.deviceId = a.deviceId || 0;
    c.deviceToken = a.deviceToken || '';
    write(c);
    return true;
  },

  clear(): void {
    localStorage.removeItem(KEY);
  },
};
