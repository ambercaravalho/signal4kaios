/** What the engine needs from the app around it: HTTP to Signal's servers, the account's IndexedDB, config, logging, and hooks for directory and chat-state changes. The app installs it once with `setEngineHost` before calling the engine. */

export interface HostHttpOptions {
  baseUrl?: string;
  noAuth?: boolean;
  basicAuth?: { username: string; password: string };
  headers?: Record<string, string>;
  timeout?: number;
}

export interface HostRawResponse {
  status: number;
  body: Uint8Array;
  location: string | null;
  /** The `Content-Range` header of a partial response. */
  range?: string | null;
}

export interface HostHttp {
  request(method: string, path: string, body: unknown, opts?: HostHttpOptions): Promise<any>;
  rawBinary(method: string, url: string, body?: Uint8Array | null, headers?: Record<string, string>, timeout?: number): Promise<Uint8Array>;
  rawRequest(method: string, url: string, body?: Uint8Array | null, headers?: Record<string, string>, timeout?: number): Promise<HostRawResponse>;
}

export interface HostDb {
  kvGet(k: string): Promise<any>;
  kvSet(k: string, v: unknown): Promise<void>;
  getAttachment(id: string): Promise<{ blob: Blob; type: string } | undefined>;
  putAttachment(id: string, blob: Blob, type: string): Promise<void>;
  signalKeyGet(k: string): Promise<any>;
  signalKeySet(k: string, v: unknown): Promise<void>;
  putIdentity(rec: unknown): Promise<void>;
  getIdentity(address: string): Promise<any>;
  deleteIdentity(address: string): Promise<void>;
  allIdentities(): Promise<any[]>;
  putSession(address: string, data: Uint8Array): Promise<void>;
  getSession(address: string): Promise<Uint8Array | undefined>;
  deleteSession(address: string): Promise<void>;
  allSessions(): Promise<any[]>;
  putPreKey(id: string, data: Uint8Array): Promise<void>;
  getPreKey(id: string): Promise<Uint8Array | undefined>;
  deletePreKey(id: string): Promise<void>;
  putSenderKey(id: string, data: Uint8Array): Promise<void>;
  getSenderKey(id: string): Promise<Uint8Array | undefined>;
}

export interface HostConfig {
  serverUrl(): string;
  aci(): string;
  profileName(): string;
  sharePhoneNumber(): boolean;
  stickerPacks(): HostStickerPack[];
  set(patch: Record<string, unknown>): void;
}

/** Archive, mute, and marked-unread state for one chat, keyed the way the app's store finds conversations (a contact's ACI or number, or a group's internal ID). `mutedUntil` is left out where Signal has no mute state (Note to Self). */
export interface ChatStateEntry {
  uuid?: string;
  number?: string;
  groupInternalId?: string;
  archived: boolean;
  /** Muted until this time in ms; 0 when not muted. */
  mutedUntil?: number;
  markedUnread?: boolean;
  /** What still notifies while the chat is muted (mentions and replies are groups only); null follows the account's default. */
  mentionsIfMuted?: boolean | null;
  repliesIfMuted?: boolean | null;
  callsIfMuted?: boolean | null;
}

export type PinnedChat = { uuid?: string; number?: string; groupInternalId?: string };

/** A chat folder (Storage `ChatFolderRecord`), shared by all the account's devices. `all` is the built-in "All chats" folder. Chats are named like notification profiles: ACIs, numbers, and `g:` + group internal IDs. */
export interface HostChatFolder {
  /** Base64 of the folder's 16-byte ID. */
  id: string;
  name: string;
  position: number;
  all: boolean;
  showOnlyUnread: boolean;
  showMutedChats: boolean;
  includeAllIndividualChats: boolean;
  includeAllGroupChats: boolean;
  included: string[];
  excluded: string[];
}

/** An installed sticker pack (Storage `StickerPackRecord`); stickers are received only, so Beacon just keeps the list. */
export interface HostStickerPack {
  /** Hex of the pack ID, as sticker messages name it. */
  id: string;
  /** SECURITY-REVIEW: hex of the pack key that decrypts the pack. */
  key: string;
  position: number;
}

/** A notification profile made on the primary phone (Storage `NotificationProfile`). */
export interface HostNotificationProfile {
  /** Base64 of the profile's ID bytes. */
  id: string;
  name: string;
  emoji: string;
  createdAt: number;
  allowAllCalls: boolean;
  allowAllMentions: boolean;
  /** Chats that still notify: ACIs, numbers, and `g:` + group internal IDs. */
  allowed: string[];
  /** Times are 24-hour clock ints (930 is 09:30); days run 1 (Monday) to 7 (Sunday). */
  schedule: { start: number; end: number; days: number[] } | null;
}

/** The account's manual override: every profile off since `disabledAt`, or one profile on until `endAt` (0 until turned off). */
export type HostProfileOverride = { disabledAt: number } | { enabledId: string; endAt: number } | null;

export interface EngineHost {
  http: HostHttp;
  db: HostDb;
  config: HostConfig;
  dbg(msg: string): void;
  /** Synced contacts or groups changed; the app should reload its directory. */
  directoryChanged(): Promise<unknown>;
  /** Archive, mute, and pinned-chat state pulled from Storage Service. `pinned` is null when the account record didn't change. */
  applyChatState(states: ChatStateEntry[], pinned: PinnedChat[] | null): void;
  /** A frame the engine made itself (group update lines), handled like a decrypted one. */
  ingest(frame: { envelope: unknown }): void;
  /** Our primary phone changed the account's number; the protocol store already has the new one. */
  numberChanged(number: string): void;
}

let current: EngineHost | null = null;

export function setEngineHost(h: EngineHost): void {
  current = h;
}

export function host(): EngineHost {
  if (!current) throw new Error('The engine host is not set');
  return current;
}
