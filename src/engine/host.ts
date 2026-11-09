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
  set(patch: Record<string, unknown>): void;
}

/** Archive, mute, and marked-unread state for one chat, keyed the way the app's store finds conversations (a contact's ACI or number, or a group's internal ID). `muted` is left out where Signal has no mute state (Note to Self). */
export interface ChatStateEntry {
  uuid?: string;
  number?: string;
  groupInternalId?: string;
  archived: boolean;
  muted?: boolean;
  markedUnread?: boolean;
}

export type PinnedChat = { uuid?: string; number?: string; groupInternalId?: string };

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
}

let current: EngineHost | null = null;

export function setEngineHost(h: EngineHost): void {
  current = h;
}

export function host(): EngineHost {
  if (!current) throw new Error('The engine host is not set');
  return current;
}
