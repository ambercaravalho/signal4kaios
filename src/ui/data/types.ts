/* Records the app keeps in IndexedDB. Field names match what 2.0.x stored, so history carries over on upgrade. */

import type { StyleRange } from './styled';

export type MessageStatus = 'pending' | 'failed' | 'sent' | 'delivered' | 'read' | 'received';

export interface Attachment {
  id: string;
  contentType: string;
  filename: string;
  size: number;
  voiceNote?: boolean;
  viewOnce?: boolean;
}

export interface Quote {
  author: string;
  timestamp: number;
  text: string;
}

export interface Message {
  /** `convId|timestamp|author` */
  id: string;
  convId: string;
  incoming: boolean;
  author: string;
  authorName: string;
  timestamp: number;
  body: string;
  styles: StyleRange[];
  /** What the user typed, with formatting markers, so a retry or edit sends the same thing. */
  raw?: string;
  quote: Quote | null;
  attachments: Attachment[];
  reactions: Record<string, string>;
  status: MessageStatus;
  deleted: boolean;
  edited: boolean;
  pinned?: boolean;
  expireSecs?: number;
  expiresAt?: number;
}

export interface Conversation {
  /** A contact's number or ACI, or `g:` + a group's internal ID. */
  id: string;
  type: 'direct' | 'group';
  groupInternalId?: string;
  /** Number or ACI for a contact, `group.` ID for a group; null until a group's details arrive. */
  sendId: string | null;
  name: string;
  lastTs: number;
  lastPreview: string;
  unread: number;
  lastReadTs: number;
  archived?: boolean;
  muted?: boolean;
  pinned?: boolean;
  expireTimer?: number;
}

export interface Contact {
  /** ACI when known, else number. */
  id: string;
  number: string;
  uuid: string;
  name: string;
  blocked: boolean;
  hasAvatar?: boolean;
}

export interface GroupRef {
  internal_id: string;
  id: string;
  name: string;
}

export type Connection = 'open' | 'connecting' | 'closed';
