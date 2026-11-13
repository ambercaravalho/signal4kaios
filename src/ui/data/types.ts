/* Records the app keeps in IndexedDB. Field names match what 2.0.x stored, so history carries over on upgrade. */

import type { GroupUpdateKind } from '../../engine/services/group-updates';
import type { PickedMention, StyleRange } from './styled';

export type MessageStatus = 'pending' | 'failed' | 'sent' | 'delivered' | 'read' | 'received';

export interface Attachment {
  id: string;
  contentType: string;
  filename: string;
  size: number;
  voiceNote?: boolean;
  viewOnce?: boolean;
  /** A voice message's bars, 0 to 255 each. */
  waveform?: number[];
  /** Length in seconds, for audio. */
  duration?: number;
  /** A blurred stand-in for a photo or video until it downloads. */
  blurHash?: string;
  width?: number;
  height?: number;
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
  /** A reply to a story, which Beacon can't show; `timestamp` is the story's. */
  story?: boolean;
}

export type NoticeKind = 'missedCall' | 'call' | 'safetyNumber' | 'groupCall' | 'pollEnded' | 'timer' | 'groupUpdate' | 'payment' | 'storyReaction';

export type CallDirection = 'incoming' | 'outgoing';
export type CallOutcome = 'accepted' | 'declined' | 'missed' | 'unanswered';

/** A line in the chat about the chat itself rather than a message someone wrote. The message's author is who made the change, or '' when that isn't known. */
export interface Notice {
  kind: NoticeKind;
  video?: boolean;
  /** For `call`: which call, which way, how it ended, and how long it lasted. */
  callId?: string;
  direction?: CallDirection;
  outcome?: CallOutcome;
  durationMs?: number;
  /** A missed call another device marked as read in its call log. */
  read?: boolean;
  /** The poll's question for `pollEnded`; the new group name for a `title` change; the emoji for `storyReaction`. */
  text?: string;
  /** The disappearing-message time, for `timer` and a group's `timer` change. */
  seconds?: number;
  /** What changed in the group, and who it's about (a service ID). */
  change?: GroupUpdateKind;
  target?: string;
  /** A permission ('only-admins' or 'every-member') or group link mode, with `from` the link mode before; for `payment`, 'notification', 'activationRequest', or 'activated'. */
  value?: string;
  from?: string;
  /** How many people were invited or had an invitation revoked. */
  count?: number;
}

/** One person's current vote; `voteCount` grows with each vote they cast, and an empty `options` means they took it back. */
export interface PollVote {
  options: number[];
  voteCount: number;
  timestamp: number;
}

export interface Poll {
  question: string;
  options: string[];
  allowMultiple: boolean;
  /** Keyed like reactions: a person's number, else their ACI; ours under our number. */
  votes: Record<string, PollVote>;
  ended?: boolean;
}

/** A shared contact (Signal's contact card), reduced to what the phone shows. */
export interface ContactCard {
  name: string;
  phones: string[];
  emails: string[];
}

/** The card a sender's phone made for a link in the message. */
export interface LinkPreview {
  url: string;
  title: string;
  description?: string;
  image?: Attachment;
}

/** An earlier version of an edited message, with when that version was sent. */
export interface MessageVersion {
  body: string;
  styles: StyleRange[];
  timestamp: number;
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
  /** Deleted for everyone by a group admin rather than its author. */
  deletedByAdmin?: boolean;
  edited: boolean;
  pinned?: boolean;
  expireSecs?: number;
  expiresAt?: number;
  notice?: Notice;
  /** A received voice message, video, or view-once media was opened, here or on another device. */
  viewed?: boolean;
  contactCard?: ContactCard;
  poll?: Poll;
  preview?: LinkPreview;
  /** Signal's server ID for a received message, which a spam report names. */
  serverGuid?: string;
  /** Delivered without revealing the sender to Signal's servers (Sealed Sender); for our messages, to every recipient. */
  sealed?: boolean;
  /** Earlier versions, oldest first; `editedAt` is when the current text was sent. */
  history?: MessageVersion[];
  editedAt?: number;
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
  /** Muted until this time in ms, or `MUTED_ALWAYS`; check with `isMuted`. */
  mutedUntil?: number;
  /** The on/off mute saved before 2.8.0, turned into `mutedUntil` on load. */
  muted?: boolean;
  /** The chat's own choice of what still notifies while it's muted (mentions and replies are groups only); unset follows the account's default. */
  mentionsIfMuted?: boolean;
  repliesIfMuted?: boolean;
  callsIfMuted?: boolean;
  pinned?: boolean;
  /** "Mark as unread" with nothing actually unread; opening the chat clears it. */
  markedUnread?: boolean;
  expireTimer?: number;
  /** This chat's bubble color (a `CHAT_COLORS` name); unset follows the default. */
  chatColor?: string;
  /** Unsent text in the composer, kept until it's sent or cleared. */
  draft?: string;
  draftMentions?: PickedMention[];
  /** A message request: someone we don't share our profile with started this 1:1 chat, or added us to this group. */
  request?: boolean;
  /** SECURITY-REVIEW: the server's spam reporting token for this person (base64), sent only with a spam report. */
  reportToken?: string;
}

export interface Contact {
  /** ACI when known, else number. */
  id: string;
  number: string;
  uuid: string;
  name: string;
  blocked: boolean;
  hasAvatar?: boolean;
  /** From Storage Service: whether their chats are accepted (profile shared or in the address book). Unknown for other contacts. */
  whitelisted?: boolean;
}

export interface GroupRef {
  internal_id: string;
  id: string;
  name: string;
}

export type Connection = 'open' | 'connecting' | 'closed';
