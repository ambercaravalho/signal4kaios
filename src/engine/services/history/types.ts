/* What a link-and-sync archive becomes: the people, groups, chats, and messages the app stores. People are keyed as everywhere else in the app, by number, else ACI. */

export interface HistoryContact {
  t: 'contact';
  aci: string;
  e164: string;
  name: string;
  /** SECURITY-REVIEW: the contact's profile key, base64; kept only in the on-device directory. */
  profileKey?: string;
  blocked: boolean;
  whitelisted: boolean;
}

export interface HistoryGroup {
  t: 'group';
  groupId: string;
  /** SECURITY-REVIEW: the group's master key, base64; kept only in the on-device directory. */
  masterKey: string;
  title: string;
  blocked: boolean;
  whitelisted: boolean;
}

export interface HistoryChat {
  t: 'chat';
  convId: string;
  groupInternalId: string | null;
  archived: boolean;
  pinned: boolean;
  /** Muted until this time in ms, `Number.MAX_SAFE_INTEGER` for always, 0 when not muted. */
  mutedUntil: number;
  markedUnread: boolean;
  expireTimer: number;
  mentionsIfMuted?: boolean;
  repliesIfMuted?: boolean;
  callsIfMuted?: boolean;
}

export type HistoryStatus = 'received' | 'sent' | 'delivered' | 'read' | 'failed';

export interface HistoryGroupUpdate {
  change: string;
  target?: string;
  text?: string;
  seconds?: number;
  value?: string;
  count?: number;
}

export interface HistoryMessage {
  t: 'message';
  convId: string;
  groupInternalId: string | null;
  incoming: boolean;
  author: string;
  timestamp: number;
  read: boolean;
  status: HistoryStatus;
  expireSecs?: number;
  expiresAt?: number;
  pinned?: boolean;
  deleted?: boolean;
  deletedByAdmin?: boolean;
  viewed?: boolean;
  /** Keyed like a stored message's reactions: the reactor's number, else ACI. */
  reactions: Record<string, string>;
  /** A data message in the JSON shape `src/ui/data/normalize` reads for received messages. */
  dm?: any;
  /** Earlier versions of an edited message, oldest first, in the same shape as `dm`. */
  revisions?: any[];
  notice?: { kind: string; video?: boolean; text?: string; value?: string; seconds?: number };
  groupUpdates?: HistoryGroupUpdate[];
  pollVotes?: Record<string, { options: number[]; voteCount: number }>;
  pollEnded?: boolean;
}

export type HistoryItem = HistoryContact | HistoryGroup | HistoryChat | HistoryMessage;

export interface HistorySelf {
  aci: string;
  e164: string;
}

export interface FrameMapper {
  /** The next frame of the archive (the first one is its `BackupInfo`); null for anything Beacon doesn't keep. Throws on a malformed frame. */
  map(frame: Uint8Array): HistoryItem | null;
}

export type CreateFrameMapper = (self: HistorySelf, groupIdOf: (masterKey: Uint8Array) => string, now: number) => FrameMapper;
