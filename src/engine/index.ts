/* The on-device Signal engine's public surface (`signalBridge`), imported by the app in `src/ui/`. The app installs an `EngineHost` (`./host`) before calling it. Each method group lives in `./bridge/`. */

import { accountMethods } from './bridge/account';
import { backfillMethods } from './bridge/backfill';
import { chatFolderMethods } from './bridge/chat-folders';
import { contactMethods } from './bridge/contact-actions';
import { client, store } from './bridge/context';
import { groupAvatarMethods } from './bridge/group-avatar';
import { groupMethods } from './bridge/groups';
import { historyMethods } from './bridge/history';
import { incomingMethods } from './bridge/incoming';
import { outgoingMethods } from './bridge/outgoing';
import { net } from './net/transport';
import { loadLibsignal } from './protocol/libsignal';

export type { ChatFolderEdit } from './bridge/chat-folders';
export type { MessageRef } from './bridge/delivery';
export type { GroupLinkPreview } from './bridge/groups';
export type { HistoryChat, HistoryContact, HistoryGroup, HistoryItem, HistoryMessage, TransferArchive } from './bridge/history';

export const signalBridge = {
  store,
  client,
  net,

  /** Loads the libsignal WebAssembly module. Resolves to the pinned libsignal version; rejects with a `LibsignalUnavailableError` whose `reason` drives the failure screen. */
  ready(): Promise<string> {
    return loadLibsignal();
  },

  ...accountMethods,
  ...incomingMethods,
  ...outgoingMethods,
  ...contactMethods,
  ...groupMethods,
  ...groupAvatarMethods,
  ...backfillMethods,
  ...historyMethods,
  ...chatFolderMethods,
};

export type SignalBridge = typeof signalBridge;
