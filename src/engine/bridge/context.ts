/* The engine's singletons: the protocol store, the Signal client, HTTP through the app's host, and the batched Storage Service writer. */

import { ContentSchema, SyncMessage_FetchLatest_Type, type Content } from '../gen/SignalService_pb';
import type { AccountRecord } from '../gen/SignalStorage_pb';
import { host } from '../host';
import { SignalClient } from '../net/client';
import { DEFAULT_SIGNAL_SERVER, type SignalHttpJsonFn } from '../net/http';
import { create } from '../net/proto';
import { IndexedDbSignalStore } from '../protocol/store';
import { mutateStorage, StorageWriteQueue } from '../services/storage';

export const store = new IndexedDbSignalStore();

export const httpJson: SignalHttpJsonFn = (method, path, body, opts) =>
  host().http.request(method, path, body, {
    baseUrl: opts?.baseUrl || host().config.serverUrl() || DEFAULT_SIGNAL_SERVER,
    noAuth: opts?.noAuth,
    basicAuth: opts?.basicAuth,
    headers: opts?.headers,
    timeout: opts?.timeout,
  });

export function httpBinary(method: string, url: string, body?: Uint8Array | null, headers?: Record<string, string>, timeout?: number): Promise<Uint8Array> {
  return host().http.rawBinary(method, url, body, headers, timeout);
}

function httpRaw(method: string, url: string, body?: Uint8Array | null, headers?: Record<string, string>, timeout?: number) {
  return host().http.rawRequest(method, url, body, headers, timeout);
}

export const client = new SignalClient(store, httpJson, httpBinary, httpRaw);
client.log = (message) => host().dbg(message);

export function serverUrl(): string {
  return host().config.serverUrl() || DEFAULT_SIGNAL_SERVER;
}

export function fetchLatestSync(type: SyncMessage_FetchLatest_Type): Content {
  return create(ContentSchema, { content: { case: 'syncMessage', value: { content: { case: 'fetchLatest', value: { type } } } } });
}

/** Storage Service writes, batched; other devices are told to re-read the manifest after each one. */
export const storageQueue = new StorageWriteQueue(
  (mutations) => mutateStorage(store, httpJson, httpBinary, serverUrl(), mutations),
  () => {
    client.sendSyncMessage(fetchLatestSync(SyncMessage_FetchLatest_Type.STORAGE_MANIFEST)).catch(() => {});
  }
);

/** Rewrite one Storage Service account record field (or several), shared with our other devices. */
export function updateAccountRecord(update: (a: AccountRecord) => void): Promise<void> {
  return storageQueue.enqueue([{ type: 'account', update }]);
}

/** Protocol store values for our own profile photo: the CDN path the profile names, and the path the cached copy came from. */
export const OWN_AVATAR_PATH = 'ownAvatarUrlPath';
export const OWN_AVATAR_CACHED_FOR = 'ownAvatarCachedFor';
/** The app's attachment cache entry for our own profile photo. */
export const OWN_AVATAR_CACHE = 'avatar:self';
