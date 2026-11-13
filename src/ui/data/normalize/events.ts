/* The store events a decrypted frame turns into. */

import type { StyleRange } from '../styled';
import type { Attachment, CallDirection, CallOutcome, ContactCard, LinkPreview, Notice, Poll, Quote } from '../types';

export interface MessageEvent {
  type: 'message';
  convId: string;
  groupInternalId: string | null;
  incoming: boolean;
  author: string;
  authorName: string;
  timestamp: number;
  body: string;
  styles: StyleRange[];
  quote: Quote | null;
  attachments: Attachment[];
  expiresInSeconds: number;
  contactCard?: ContactCard;
  poll?: Pick<Poll, 'question' | 'options' | 'allowMultiple'>;
  preview?: LinkPreview;
  /** Delivered without revealing the sender to Signal's servers (Sealed Sender). */
  sealed?: boolean;
  serverGuid?: string;
  reportToken?: string;
  /** The ACIs the message mentions. */
  mentioned?: string[];
}

export interface NoticeEvent {
  type: 'notice';
  convId: string;
  groupInternalId: string | null;
  author: string;
  timestamp: number;
  notice: Notice;
}

export type StoreEvent =
  | MessageEvent
  | NoticeEvent
  | { type: 'edit'; convId: string; author: string; targetTimestamp: number; newBody: string; newStyles: StyleRange[]; timestamp: number }
  | { type: 'reaction'; convId: string; reactor: string; emoji: string; remove: boolean; targetAuthor: string; targetTimestamp: number }
  | { type: 'remoteDelete'; convId: string; author: string; targetTimestamp: number }
  | { type: 'pin' | 'unpin'; convId: string; targetAuthor: string; targetTimestamp: number }
  | { type: 'timer'; convId: string; seconds: number; author: string; timestamp: number }
  | { type: 'typing'; convId: string; author: string; started: boolean }
  | { type: 'receipt'; peer: string; kind: 'read' | 'delivery' | 'other'; timestamps: number[] }
  | { type: 'readSync'; entries: SyncRef[] }
  | { type: 'viewedSync'; entries: SyncRef[]; viewOnce: boolean }
  | { type: 'adminDelete'; convId: string; admin: string; targetAuthor: string; targetTimestamp: number; timestamp: number }
  | { type: 'deleteSync'; messages: Array<{ chat: ChatRef; items: SyncRef[] }>; chats: ChatDelete[] }
  | { type: 'requestResponse'; chat: ChatRef; response: RequestResponse }
  | { type: 'backfill'; chat: ChatRef; author: string; timestamp: number; slots: BackfillSlot[] | null }
  | { type: 'pollVote'; convId: string; voter: string; targetAuthor: string; targetTimestamp: number; options: number[]; voteCount: number; timestamp: number }
  | { type: 'pollEnd'; convId: string; author: string; targetTimestamp: number; timestamp: number }
  | CallEvent
  | { type: 'callDelete'; chat: ChatRef; callId: string }
  | { type: 'callLog'; action: 'read' | 'clear'; chat: ChatRef | null; timestamp: number };

/** A 1:1 call's line in the chat, from this device or synced from another; a later event for the same call replaces it. */
export interface CallEvent {
  type: 'call';
  chat: ChatRef;
  callId: string;
  direction: CallDirection;
  outcome: CallOutcome;
  timestamp: number;
  durationMs: number;
}

/** One attachment in our phone's answer to a backfill request: a fresh copy, still uploading, or gone. */
export type BackfillSlot = Attachment | 'pending' | 'failed';

export type RequestResponse = 'accept' | 'delete' | 'block' | 'blockAndDelete' | 'spam' | 'blockAndSpam';
/** A message our other device read or opened: who sent it and when. */
export interface SyncRef {
  sender: string;
  timestamp: number;
}

/** A chat named by a sync message: `g:` + group ID, or a person's number or ACI. */
export interface ChatRef {
  key: string;
}

/** A chat our other device deleted: everything up to its newest listed message, and the chat itself on a full delete. */
export interface ChatDelete {
  chat: ChatRef;
  mostRecent: SyncRef[];
  mostRecentNonExpiring: SyncRef[];
  isFullDelete: boolean;
}

export type NameOf = (key: string) => string;
export type Conv = { convId: string | null; groupInternalId: string | null };
