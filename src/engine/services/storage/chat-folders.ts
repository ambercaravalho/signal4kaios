/* Chat folders (Storage record type 8), read and written the way Signal-Desktop's storageRecordOps and types/ChatFolder do. */

import type { MessageInitShape } from '@bufbuild/protobuf';

import { fromBase64, toBase64, uuidToBytes } from '../../bytes';
import { type ChatFolderRecord, ChatFolderRecord_FolderType, type Recipient, RecipientSchema } from '../../gen/SignalStorage_pb';
import type { HostChatFolder } from '../../host';
import { create } from '../../net/proto';
import { recipientKeys } from './notification-profiles';

/** Signal-Desktop `CHAT_FOLDER_NAME_MAX_CHAR_LENGTH`, in graphemes. */
export const CHAT_FOLDER_NAME_MAX = 32;
/** Signal-Desktop `CHAT_FOLDER_DELETED_POSITION`: a deleted folder's position (2^32 - 1). */
export const CHAT_FOLDER_DELETED_POSITION = 4294967295;
const MAX_RECIPIENTS = 500;

/** A folder as the app uses it; null once it's deleted or of a type we don't know. */
export function readChatFolder(f: ChatFolderRecord): HostChatFolder | null {
  if (f.deletedAtTimestampMs > 0n || f.id.length !== 16) return null;
  if (f.folderType !== ChatFolderRecord_FolderType.ALL && f.folderType !== ChatFolderRecord_FolderType.CUSTOM) return null;
  return {
    id: toBase64(f.id),
    name: f.name.slice(0, 200),
    position: f.position,
    all: f.folderType === ChatFolderRecord_FolderType.ALL,
    showOnlyUnread: f.showOnlyUnread,
    showMutedChats: f.showMutedChats,
    includeAllIndividualChats: f.includeAllIndividualChats,
    includeAllGroupChats: f.includeAllGroupChats,
    included: f.includedRecipients.slice(0, MAX_RECIPIENTS).flatMap(recipientKeys),
    excluded: f.excludedRecipients.slice(0, MAX_RECIPIENTS).flatMap(recipientKeys),
  };
}

/** What a chat in a folder is written as: a contact's ACI and number, or a group's master key. */
export type FolderRecipient = { aci?: string; e164?: string } | { masterKey: Uint8Array };

export function folderRecipient(r: FolderRecipient): Recipient {
  const init: MessageInitShape<typeof RecipientSchema> =
    'masterKey' in r
      ? { identifier: { case: 'groupMasterKey', value: r.masterKey } }
      : { identifier: { case: 'contact', value: { serviceId: r.aci || '', serviceIdBinary: r.aci ? uuidToBytes(r.aci) : undefined, e164: r.e164 || '' } } };
  return create(RecipientSchema, init);
}

export interface ChatFolderFields {
  name: string;
  showOnlyUnread: boolean;
  showMutedChats: boolean;
  includeAllIndividualChats: boolean;
  includeAllGroupChats: boolean;
  included: FolderRecipient[];
  excluded: FolderRecipient[];
}

/** Write a custom folder's settings; `position` only when it's new or moves. */
export function writeChatFolder(f: ChatFolderRecord, fields: ChatFolderFields, position?: number): void {
  f.folderType = ChatFolderRecord_FolderType.CUSTOM;
  f.name = fields.name;
  f.showOnlyUnread = fields.showOnlyUnread;
  f.showMutedChats = fields.showMutedChats;
  f.includeAllIndividualChats = fields.includeAllIndividualChats;
  f.includeAllGroupChats = fields.includeAllGroupChats;
  f.includedRecipients = fields.included.map(folderRecipient);
  f.excludedRecipients = fields.excluded.map(folderRecipient);
  f.deletedAtTimestampMs = 0n;
  if (position !== undefined) f.position = position;
}

/** Signal-Desktop `ALL_CHATS_FOLDER_REQUIRED_PARAMS`, for a record that isn't the "All chats" folder yet. */
export function ensureAllChatsFolder(f: ChatFolderRecord): void {
  if (f.folderType === ChatFolderRecord_FolderType.ALL) return;
  f.folderType = ChatFolderRecord_FolderType.ALL;
  f.name = '';
  f.position = 0;
  f.showOnlyUnread = false;
  f.showMutedChats = true;
  f.includeAllIndividualChats = true;
  f.includeAllGroupChats = true;
  f.includedRecipients = [];
  f.excludedRecipients = [];
}

/** A deleted folder keeps its record, with the deletion time, the deleted position, and no chats. */
export function markChatFolderDeleted(f: ChatFolderRecord, now: number): void {
  f.deletedAtTimestampMs = BigInt(Math.max(1, Math.floor(now)));
  f.position = CHAT_FOLDER_DELETED_POSITION;
  f.includedRecipients = [];
  f.excludedRecipients = [];
}

export function chatFolderId(id: string): Uint8Array {
  const bytes = fromBase64(id);
  if (bytes.length !== 16) throw new Error('Invalid chat folder ID');
  return bytes;
}
