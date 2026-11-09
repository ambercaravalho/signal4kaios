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
  theme?: ThemeName;
  sendReadReceipts?: boolean;
  styledText?: boolean;
  typingIndicators?: boolean;
  keepMutedArchived?: boolean;
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

  /** Muted chats stay archived when new messages arrive, as in Signal. */
  keepMutedArchived(): boolean {
    return read().keepMutedArchived !== false;
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
