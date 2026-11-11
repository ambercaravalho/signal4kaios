/* Account and app settings in localStorage (`s4k.config`). The active account's credentials sit at the top level; `accounts` holds every saved account so the user can switch, and each account has its own IndexedDB. */

const KEY = 's4k.config';
export const DEFAULT_SIGNAL_SERVER = 'https://chat.signal.org';

export interface SavedAccount {
  number: string;
  aci: string;
  deviceId: number;
  serverUrl: string;
  deviceToken: string;
}

export type ThemeName = 'light' | 'dark';

/** The screen lock PIN's salted hash, how long the app may sit in the background before locking, and the wrong-PIN count. */
export interface ScreenLockConfig {
  salt: string;
  hash: string;
  iterations: number;
  lockAfter: number;
  failures: number;
  retryAt: number;
}

interface ConfigData {
  serverUrl?: string;
  number?: string;
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

  number(): string {
    return read().number || '';
  },

  aci(): string {
    return read().aci || '';
  },

  deviceId(): number {
    return read().deviceId || 0;
  },

  /** The linked device's Signal password. Never logged. */
  deviceToken(): string {
    return read().deviceToken || '';
  },

  deviceName(): string {
    return read().deviceName || '';
  },

  username(): string {
    return read().username || '';
  },

  usernameLink(): string {
    return read().usernameLink || '';
  },

  profileName(): string {
    return read().profileName || '';
  },

  profileAbout(): string {
    return read().profileAbout || '';
  },

  profileAboutEmoji(): string {
    return read().profileAboutEmoji || '';
  },

  theme(): ThemeName {
    return read().theme === 'dark' ? 'dark' : 'light';
  },

  sendReadReceipts(): boolean {
    return read().sendReadReceipts !== false;
  },

  styledText(): boolean {
    return read().styledText !== false;
  },

  typingIndicators(): boolean {
    return read().typingIndicators !== false;
  },

  linkPreviews(): boolean {
    return read().linkPreviews !== false;
  },

  sealedSenderIndicators(): boolean {
    return read().sealedSenderIndicators === true;
  },

  defaultExpireTimer(): number {
    const v = read().defaultExpireTimer;
    return typeof v === 'number' && v > 0 ? Math.floor(v) : 0;
  },

  /** Whether everybody sees our number; Signal defaults to nobody. */
  sharePhoneNumber(): boolean {
    return read().sharePhoneNumber === true;
  },

  findableByNumber(): boolean {
    return config.sharePhoneNumber() || read().findableByNumber !== false;
  },

  /** Muted chats stay archived when new messages arrive, as in Signal. */
  keepMutedArchived(): boolean {
    return read().keepMutedArchived !== false;
  },

  /** The Signal proxy's hostname, kept while the proxy is turned off. */
  proxyAddress(): string {
    const v = read().proxyAddress;
    return typeof v === 'string' ? v : '';
  },

  proxyEnabled(): boolean {
    return read().proxyEnabled === true;
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
      retryAt: typeof s.retryAt === 'number' && s.retryAt > 0 ? s.retryAt : 0,
    };
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
      aci: c.aci || '',
      deviceId: c.deviceId || 0,
      serverUrl: c.serverUrl || DEFAULT_SIGNAL_SERVER,
      deviceToken: c.deviceToken || '',
    };
    const i = list.findIndex((a) => a.number === entry.number || (!!entry.aci && a.aci === entry.aci));
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    c.accounts = list;
    write(c);
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
