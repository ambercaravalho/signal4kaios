/* Account and app settings in localStorage (`s4k.config`). The active account's credentials sit at the top level; `accounts` holds every saved account so the user can switch, and each account has its own IndexedDB. */

import type { HostChatFolder, HostNotificationProfile, HostProfileOverride, HostStickerPack } from '../../engine/host';

const KEY = 's4k.config';
const DEFAULT_SIGNAL_SERVER = 'https://chat.signal.org';

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
  retryAt: number;
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
  [k: string]: unknown;
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
  | 'proxyEnabled';

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

  screenLock(): ScreenLockConfig | null {
    const s = read().screenLock;
    if (!s || typeof s.salt !== 'string' || typeof s.hash !== 'string' || !(s.iterations > 0)) return null;
    return {
      salt: s.salt,
      hash: s.hash,
      iterations: s.iterations,
      lockAfter: typeof s.lockAfter === 'number' && s.lockAfter >= 0 ? s.lockAfter : 60,
      failures: typeof s.failures === 'number' && s.failures > 0 ? s.failures : 0,
      retryAt: typeof s.retryAt === 'number' && s.retryAt > 0 ? s.retryAt : 0,
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

  /** Insert or update the active account in the saved list. */
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
    write(c);
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

  /** Drop the active account's device credentials, after unlinking or a 401. */
  forgetAccount(): void {
    const c = read();
    const num = c.number;
    const aci = c.aci;
    c.deviceToken = '';
    c.deviceId = 0;
    c.accounts = (c.accounts || []).filter((a) => a.number !== num && (!aci || a.aci !== aci));
    write(c);
  },

  /** Make a saved account active. The caller reloads so the right database and connection are used. */
  switchAccount(number: string): boolean {
    const c = read();
    const a = (c.accounts || []).find((x) => x.number === number);
    if (!a) return false;
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
