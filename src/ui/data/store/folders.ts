/* Chat folders: which chats each one shows, ported from Signal-Desktop's types/ChatFolder, and editing them. Folders live in Storage Service; the list the app shows comes from config, updated here right away and replaced by the next pull. */

import type { ChatFolderEdit } from '../../../engine';
import type { HostChatFolder } from '../../../engine/host';
import { signal } from '../api';
import { config } from '../config';
import type { Conversation } from '../types';
import { altKeyOf } from './contacts';
import { emit } from './events';
import { isMuted } from './mute';

export type { HostChatFolder as ChatFolder } from '../../../engine/host';

/** Signal-Desktop `CHAT_FOLDER_NAME_MAX_CHAR_LENGTH`, in graphemes. */
export const FOLDER_NAME_MAX = 32;

const COMBINING = /^[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe00-\ufe0f\ufe20-\ufe2f\u200d]|^\udb40[\udc20-\udc7f]|^\ud83c[\udffb-\udfff]/;

/** Roughly what a reader counts as characters: combining marks, variation selectors, skin tones, and joined emoji count with the one before. Gecko 84 has no `Intl.Segmenter`. */
export function graphemeCount(s: string): number {
  let n = 0;
  let joined = false;
  for (const ch of Array.from(s)) {
    if (COMBINING.test(ch)) {
      joined = ch === '\u200d';
      continue;
    }
    if (!joined) n++;
    joined = false;
  }
  return n;
}

/** The folders in display order. The "All chats" folder comes first when the phone hasn't placed it, as it does in Signal. */
export function foldersInOrder(list: HostChatFolder[] = config.chatFolders()): HostChatFolder[] {
  const sorted = list.slice().sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  if (sorted.length && !sorted.some((f) => f.all)) sorted.unshift({ id: '', name: '', position: 0, all: true, showOnlyUnread: false, showMutedChats: true, includeAllIndividualChats: true, includeAllGroupChats: true, included: [], excluded: [] });
  return sorted;
}

/** Whether a folder's list of chats names `conv`, by either of a contact's keys. */
export function named(keys: string[], conv: Conversation): boolean {
  if (keys.indexOf(conv.id) >= 0) return true;
  const alt = conv.type === 'direct' ? altKeyOf(conv.id) : null;
  return !!alt && keys.indexOf(alt) >= 0;
}

/** Signal-Desktop `isConversationInChatFolder`. */
export function folderIncludes(folder: HostChatFolder, conv: Conversation, now = Date.now()): boolean {
  if (folder.all) return true;
  const included = (folder.includeAllIndividualChats && conv.type === 'direct') || (folder.includeAllGroupChats && conv.type === 'group') || named(folder.included, conv);
  if (!included) return false;
  if (folder.showOnlyUnread && !(conv.unread > 0 || conv.markedUnread)) return false;
  if (!folder.showMutedChats && isMuted(conv, now)) return false;
  return !named(folder.excluded, conv);
}

function setFolders(list: HostChatFolder[]): void {
  config.set({ chatFolders: list });
  emit('conversations');
}

/** Create or change a folder, here and on the account's other devices. */
export async function saveFolder(edit: ChatFolderEdit): Promise<string> {
  const list = config.chatFolders();
  const position = list.reduce((max, f) => Math.max(max, f.position + 1), 1);
  const id = await signal.saveChatFolder(edit, position);
  const next: HostChatFolder = { ...edit, id, all: false, name: edit.name.normalize().trim(), position: edit.id ? (list.find((f) => f.id === edit.id) || { position }).position : position };
  setFolders(list.filter((f) => f.id !== id).concat(next));
  return id;
}

export async function deleteFolder(id: string): Promise<void> {
  await signal.deleteChatFolder(id);
  setFolders(config.chatFolders().filter((f) => f.id !== id));
}

/** Move a folder one place up (-1) or down (1) among all folders, "All chats" included. */
export async function moveFolder(id: string, by: -1 | 1): Promise<void> {
  const order = foldersInOrder();
  const i = order.findIndex((f) => f.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  const ids = order.map((f) => f.id).filter(Boolean);
  await signal.reorderChatFolders(ids);
  const positions = new Map(ids.map((fid, p) => [fid, p] as [string, number]));
  setFolders(config.chatFolders().map((f) => (positions.has(f.id) ? { ...f, position: positions.get(f.id)! } : f)));
}
