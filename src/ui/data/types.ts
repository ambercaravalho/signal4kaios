/* Records the app keeps in IndexedDB. Field names match what 2.0.x stored, so history carries over on upgrade. */

import type { PickedMention, StyleRange } from './styled';

export type MessageStatus = 'pending' | 'failed' | 'sent' | 'delivered' | 'read' | 'received';

export interface Attachment {
  id: string;
  contentType: string;
  filename: string;
  size: number;
  voiceNote?: boolean;
  viewOnce?: boolean;
}

export interface QuotedAttachment {
  contentType: string;
  filename: string;
}

export interface Quote {
  author: string;
  timestamp: number;
  text: string;
  attachments?: QuotedAttachment[];
}

export type NoticeKind = 'missedCall' | 'safetyNumber' | 'groupCall';

/** A line in the chat about the chat itself rather than a message someone wrote. */
export interface Notice {
  kind: NoticeKind;
  video?: boolean;
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
  /** People picked with Mention when this was typed, so a retry or edit mentions them again. */
  mentions?: PickedMention[];
  quote: Quote | null;
  attachments: Attachment[];
  reactions: Record<string, string>;
  status: MessageStatus;
  deleted: boolean;
  edited: boolean;
  pinned?: boolean;
  expireSecs?: number;
  expiresAt?: number;
  notice?: Notice;
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
  /** Unsent text in the composer, kept until it's sent or cleared. */
  draft?: string;
  draftMentions?: PickedMention[];
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
