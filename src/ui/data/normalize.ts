/* Turns the JSON frames the engine produces from decrypted envelopes into typed events for the store. Frames are untrusted: unknown or malformed shapes are logged and dropped, never thrown. */

import { dbg } from './log';
import type { StyleRange } from './styled';
import type { Attachment, ContactCard, Notice, NoticeKind, Poll, Quote } from './types';

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
  /** Delivered without revealing the sender to Signal's servers (Sealed Sender). */
  sealed?: boolean;
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
  | { type: 'timer'; convId: string; seconds: number }
  | { type: 'typing'; convId: string; author: string; started: boolean }
  | { type: 'receipt'; peer: string; kind: 'read' | 'delivery' | 'other'; timestamps: number[] }
  | { type: 'readSync'; entries: SyncRef[] }
  | { type: 'viewedSync'; entries: SyncRef[]; viewOnce: boolean }
  | { type: 'adminDelete'; convId: string; admin: string; targetAuthor: string; targetTimestamp: number; timestamp: number }
  | { type: 'deleteSync'; messages: Array<{ chat: ChatRef; items: SyncRef[] }>; chats: ChatDelete[] }
  | { type: 'requestResponse'; chat: ChatRef; response: RequestResponse }
  | { type: 'pollVote'; convId: string; voter: string; targetAuthor: string; targetTimestamp: number; options: number[]; voteCount: number; timestamp: number }
  | { type: 'pollEnd'; convId: string; author: string; targetTimestamp: number; timestamp: number };

export type RequestResponse = 'accept' | 'delete' | 'block' | 'blockAndDelete' | 'spam' | 'blockAndSpam';
const REQUEST_RESPONSES: RequestResponse[] = ['accept', 'delete', 'block', 'blockAndDelete', 'spam', 'blockAndSpam'];

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

const MAX_SYNC_DELETES = 500;

type NameOf = (key: string) => string;
type Conv = { convId: string | null; groupInternalId: string | null };

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : 0;
  return isFinite(n) ? n : 0;
}

function peerKey(env: any): string | null {
  return str(env.sourceNumber) || str(env.sourceUuid) || str(env.source) || null;
}

function convFor(env: any, dm: any): Conv {
  const gi = dm && dm.groupInfo;
  if (gi && gi.groupId) return { convId: 'g:' + gi.groupId, groupInternalId: str(gi.groupId) };
  return { convId: peerKey(env), groupInternalId: null };
}

/* Mentions arrive as U+FFFC placeholders in the body plus a parallel list of who; splice "@name" back in. Offsets are UTF-16 units, matching JS indices. */
function mentionName(m: any, nameOf: NameOf): string {
  if (m.name) return str(m.name);
  const key = str(m.number) || str(m.uuid);
  return key ? nameOf(key) : 'unknown';
}

export function applyMentions(body: string, mentions: any[] | undefined, nameOf: NameOf): string {
  if (!body || !Array.isArray(mentions) || !mentions.length) return body || '';
  const sorted = mentions.slice().sort((a, b) => num(b.start) - num(a.start));
  let out = body;
  for (const m of sorted) {
    const start = num(m.start);
    const len = num(m.length) || 1;
    if (start < 0 || start > out.length) {
      dbg('normalize: mention offset out of range');
      continue;
    }
    out = out.slice(0, start) + '@' + mentionName(m, nameOf) + out.slice(start + len);
  }
  return out;
}

/** Map an offset in the original body to the same place after mentions are spliced in, so style ranges stay aligned. */
function remapOffset(pos: number, mentions: any[] | undefined, nameOf: NameOf): number {
  if (!Array.isArray(mentions) || !mentions.length) return pos;
  const sorted = mentions.slice().sort((a, b) => num(a.start) - num(b.start));
  let shift = 0;
  for (const m of sorted) {
    const ms = num(m.start);
    const ml = num(m.length) || 1;
    const repl = ('@' + mentionName(m, nameOf)).length;
    if (pos >= ms + ml) shift += repl - ml;
    else if (pos > ms) return ms + shift;
  }
  return pos + shift;
}

function parseStyleEntry(e: any): StyleRange | null {
  if (typeof e === 'string') {
    const p = e.split(':');
    return { start: parseInt(p[0], 10), length: parseInt(p[1], 10), style: (p[2] || '').toUpperCase() };
  }
  if (e && typeof e === 'object') return { start: e.start | 0, length: e.length | 0, style: str(e.style).toUpperCase() };
  return null;
}

export function stylesOf(dm: any, nameOf: NameOf): StyleRange[] {
  const raw = dm.textStyles || dm.textStyle;
  if (!raw) return [];
  const out: StyleRange[] = [];
  for (const e of ([] as any[]).concat(raw)) {
    const s = parseStyleEntry(e);
    if (!s || !s.style || isNaN(s.start) || isNaN(s.length)) continue;
    const start = remapOffset(s.start, dm.mentions, nameOf);
    const end = remapOffset(s.start + s.length, dm.mentions, nameOf);
    if (end > start) out.push({ start, length: end - start, style: s.style });
  }
  return out;
}

const NOTICE_KINDS: NoticeKind[] = ['missedCall', 'safetyNumber', 'groupCall'];

function noticeEvent(env: any, n: any, conv: Conv, author: string): StoreEvent[] {
  const kind = str(n && n.kind) as NoticeKind;
  if (NOTICE_KINDS.indexOf(kind) < 0 || !conv.convId) {
    dbg('normalize: unknown notice');
    return [];
  }
  const notice: Notice = { kind };
  if (n.video) notice.video = true;
  return [{ type: 'notice', convId: conv.convId, groupInternalId: conv.groupInternalId, author, timestamp: num(n.timestamp) || num(env.timestamp), notice }];
}

function quoteOf(dm: any): Quote | null {
  const q = dm.quote;
  if (!q || typeof q !== 'object') return null;
  const out: Quote = { author: str(q.authorNumber) || str(q.authorUuid) || str(q.author), timestamp: num(q.id) || num(q.timestamp), text: str(q.text) };
  const atts = Array.isArray(q.attachments) ? q.attachments.filter((a: any) => a && typeof a === 'object').slice(0, 10) : [];
  if (atts.length) out.attachments = atts.map((a: any) => ({ contentType: str(a.contentType), filename: str(a.filename) }));
  return out;
}

function dataMessageEvents(env: any, dm: any, incoming: boolean, nameOf: NameOf, authorOverride?: string, convOverride?: Conv): StoreEvent[] {
  const conv = convOverride || convFor(env, dm);
  const author = authorOverride || peerKey(env) || '';
  if (!conv.convId) {
    dbg('normalize: no conversation for message');
    return [];
  }
  const convId = conv.convId;

  if (dm.reaction) {
    const r = dm.reaction;
    return [
      {
        type: 'reaction',
        convId,
        reactor: author,
        emoji: str(r.emoji),
        remove: !!r.isRemove,
        targetAuthor: str(r.targetAuthorNumber) || str(r.targetAuthorUuid) || str(r.targetAuthor),
        targetTimestamp: num(r.targetSentTimestamp) || num(r.targetTimestamp),
      },
    ];
  }

  if (dm.remoteDelete) return [{ type: 'remoteDelete', convId, author, targetTimestamp: num(dm.remoteDelete.timestamp) }];

  if (dm.adminDelete) {
    const ad = dm.adminDelete;
    const admin = str(env.sourceUuid);
    const targetAuthor = str(ad.targetAuthorUuid);
    if (!conv.groupInternalId || !admin || !targetAuthor) return [];
    return [{ type: 'adminDelete', convId, admin, targetAuthor, targetTimestamp: num(ad.targetSentTimestamp), timestamp: num(dm.timestamp) || num(env.timestamp) }];
  }

  if (dm.pinMessage || dm.unpinMessage) {
    const pin = dm.pinMessage || dm.unpinMessage;
    return [
      {
        type: dm.pinMessage ? 'pin' : 'unpin',
        convId,
        targetAuthor: str(pin.targetAuthorNumber) || str(pin.targetAuthorUuid) || str(pin.targetAuthor),
        targetTimestamp: num(pin.targetSentTimestamp) || num(pin.timestamp),
      },
    ];
  }

  if (dm.pollVote) {
    const v = dm.pollVote;
    const options: unknown[] = Array.isArray(v.optionIndexes) ? v.optionIndexes : [];
    const targetAuthor = str(v.targetAuthorUuid);
    const valid = options.length <= MAX_POLL_OPTIONS && options.every((i) => typeof i === 'number' && i >= 0 && i < MAX_POLL_OPTIONS);
    if (!conv.groupInternalId || !targetAuthor || !valid) return [];
    return [{ type: 'pollVote', convId, voter: author, targetAuthor, targetTimestamp: num(v.targetSentTimestamp), options: options as number[], voteCount: num(v.voteCount), timestamp: num(dm.timestamp) || num(env.timestamp) }];
  }

  if (dm.pollTerminate) {
    if (!conv.groupInternalId) return [];
    return [{ type: 'pollEnd', convId, author, targetTimestamp: num(dm.pollTerminate.targetSentTimestamp), timestamp: num(dm.timestamp) || num(env.timestamp) }];
  }

  if (dm.expirationTimerUpdate) return [{ type: 'timer', convId, seconds: num(dm.expiresInSeconds) }];
  if (dm.groupCallUpdate) return noticeEvent(env, { kind: 'groupCall', timestamp: num(dm.timestamp) || num(env.timestamp) }, conv, author);

  const attachments: any[] = Array.isArray(dm.attachments) ? dm.attachments : [];
  const body = dm.message;
  const card = contactCardOf(dm);
  const poll = pollOf(dm);
  if (body == null && attachments.length === 0 && !dm.sticker && !card && !poll) {
    dbg('normalize: message without text');
    return [];
  }

  const ev: MessageEvent = {
    type: 'message',
    convId,
    groupInternalId: conv.groupInternalId,
    incoming,
    author,
    authorName: str(env.sourceName),
    timestamp: num(dm.timestamp) || num(env.timestamp),
    body: applyMentions(str(body), dm.mentions, nameOf),
    styles: stylesOf(dm, nameOf),
    quote: quoteOf(dm),
    attachments: attachments.map((a) => ({
      id: str(a.id),
      contentType: str(a.contentType),
      filename: str(a.filename),
      size: num(a.size),
      voiceNote: !!a.voiceNote,
      viewOnce: !!(a.viewOnce || dm.viewOnce),
    })),
    expiresInSeconds: num(dm.expiresInSeconds),
  };
  if (card) ev.contactCard = card;
  if (poll) ev.poll = poll;
  if (incoming ? env.sealed === true : dm.sealed === true) ev.sealed = true;
  return [ev];
}

function strings(list: unknown, max: number): string[] {
  return Array.isArray(list) ? list.map(str).filter(Boolean).slice(0, max) : [];
}

function contactCardOf(dm: any): ContactCard | null {
  const c = Array.isArray(dm.contacts) ? dm.contacts[0] : null;
  if (!c || typeof c !== 'object') return null;
  const card: ContactCard = { name: str(c.name).slice(0, 100), phones: strings(c.phones, 5), emails: strings(c.emails, 5) };
  return card.name || card.phones.length || card.emails.length ? card : null;
}

const MAX_POLL_OPTIONS = 10;

function pollOf(dm: any): MessageEvent['poll'] | null {
  const p = dm.pollCreate;
  if (!p || typeof p !== 'object') return null;
  const question = str(p.question);
  const options = Array.isArray(p.options) ? p.options.map(str) : [];
  if (!question || options.length < 2 || options.length > MAX_POLL_OPTIONS || options.some((o: string) => !o)) return null;
  return { question, options, allowMultiple: !!p.allowMultiple };
}

function editEvent(env: any, edit: any, author: string, nameOf: NameOf, convOverride?: Conv): StoreEvent[] {
  const dm = edit.dataMessage || {};
  const conv = convOverride || convFor(env, dm);
  if (!conv.convId) {
    dbg('normalize: no conversation for edit');
    return [];
  }
  return [
    {
      type: 'edit',
      convId: conv.convId,
      author,
      targetTimestamp: num(edit.targetSentTimestamp) || num(edit.targetTimestamp),
      newBody: applyMentions(str(dm.message), dm.mentions, nameOf),
      newStyles: stylesOf(dm, nameOf),
      timestamp: num(dm.timestamp) || num(env.timestamp),
    },
  ];
}

/** Events for one decrypted frame. `selfNumber` is the author of messages synced from our other devices; `nameOf` names mentioned people. */
export function parseFrame(frame: any, selfNumber: string, nameOf: NameOf): StoreEvent[] {
  const env = frame && frame.envelope;
  if (!env || typeof env !== 'object') {
    dbg('normalize: frame without envelope');
    return [];
  }

  const events = envelopeEvents(env, selfNumber, nameOf);
  const peer = peerKey(env);
  // One millisecond early, so it sits before the message it arrived with and can't share that message's ID.
  if (env.safetyNumberChanged && peer) events.unshift(...noticeEvent(env, { kind: 'safetyNumber', timestamp: (num(env.timestamp) || Date.now()) - 1 }, { convId: peer, groupInternalId: null }, peer));
  return events;
}

function syncRefs(list: unknown): SyncRef[] {
  if (!Array.isArray(list)) return [];
  const out: SyncRef[] = [];
  for (const r of list) {
    if (!r) continue;
    const sender = str(r.senderNumber) || str(r.senderUuid) || str(r.sender);
    if (sender && r.timestamp) out.push({ sender, timestamp: num(r.timestamp) });
  }
  return out;
}

function chatRef(c: any): ChatRef | null {
  if (!c || typeof c !== 'object') return null;
  const key = c.groupId ? 'g:' + str(c.groupId) : str(c.number) || str(c.uuid);
  return key && key !== 'g:' ? { key } : null;
}

function addressed(list: unknown): SyncRef[] {
  return syncRefs(Array.isArray(list) ? list.slice(0, MAX_SYNC_DELETES).map((m: any) => m && { sender: m.author, timestamp: m.timestamp }) : []);
}

function deleteSyncEvent(d: any): StoreEvent | null {
  const messages: Array<{ chat: ChatRef; items: SyncRef[] }> = [];
  for (const md of Array.isArray(d.messages) ? d.messages : []) {
    const chat = md && chatRef(md.conversation);
    const items = md ? addressed(md.messages) : [];
    if (chat && items.length) messages.push({ chat, items });
  }
  const chats: ChatDelete[] = [];
  for (const cd of Array.isArray(d.conversations) ? d.conversations : []) {
    const chat = cd && chatRef(cd.conversation);
    if (chat) chats.push({ chat, mostRecent: addressed(cd.mostRecent), mostRecentNonExpiring: addressed(cd.mostRecentNonExpiring), isFullDelete: !!cd.isFullDelete });
  }
  return messages.length || chats.length ? { type: 'deleteSync', messages, chats } : null;
}

function envelopeEvents(env: any, selfNumber: string, nameOf: NameOf): StoreEvent[] {
  if (env.notice) return noticeEvent(env, env.notice, { convId: peerKey(env), groupInternalId: null }, peerKey(env) || '');
  if (env.dataMessage) return dataMessageEvents(env, env.dataMessage, true, nameOf);
  if (env.editMessage) return editEvent(env, env.editMessage, peerKey(env) || '', nameOf);

  if (env.typingMessage) {
    const tm = env.typingMessage;
    const convId = tm.groupId ? 'g:' + tm.groupId : peerKey(env);
    if (!convId) return [];
    return [{ type: 'typing', convId, author: peerKey(env) || '', started: tm.action === 'STARTED' }];
  }

  if (env.receiptMessage) {
    const rm = env.receiptMessage;
    const peer = peerKey(env);
    if (!peer) return [];
    const timestamps: number[] = Array.isArray(rm.timestamps) ? rm.timestamps.map(num) : rm.when ? [num(rm.when)] : [];
    return [{ type: 'receipt', peer, kind: rm.isRead || rm.isViewed ? 'read' : rm.isDelivery ? 'delivery' : 'other', timestamps }];
  }

  if (env.syncMessage) {
    const sm = env.syncMessage;
    if (sm.sentMessage) {
      const sent = sm.sentMessage;
      const dest = str(sent.destinationNumber) || str(sent.destinationUuid) || str(sent.destination);
      const conv: Conv = sent.groupInfo && sent.groupInfo.groupId ? { convId: 'g:' + sent.groupInfo.groupId, groupInternalId: str(sent.groupInfo.groupId) } : { convId: dest || null, groupInternalId: null };
      if (sent.editMessage) return editEvent(env, sent.editMessage, selfNumber, nameOf, conv);
      return dataMessageEvents(env, sent, false, nameOf, selfNumber, conv);
    }
    const out: StoreEvent[] = [];
    const read = syncRefs(sm.readMessages);
    if (read.length) out.push({ type: 'readSync', entries: read });
    const viewed = syncRefs(sm.viewedMessages);
    if (viewed.length) out.push({ type: 'viewedSync', entries: viewed, viewOnce: false });
    const opened = syncRefs(sm.viewOnceOpen ? [sm.viewOnceOpen] : undefined);
    if (opened.length) out.push({ type: 'viewedSync', entries: opened, viewOnce: true });
    const mrr = sm.messageRequestResponse;
    if (mrr && typeof mrr === 'object') {
      const chat = chatRef({ groupId: mrr.groupId, uuid: mrr.threadUuid });
      const response = str(mrr.type) as RequestResponse;
      if (chat && REQUEST_RESPONSES.indexOf(response) >= 0) out.push({ type: 'requestResponse', chat, response });
    }
    if (sm.deleteForMe && typeof sm.deleteForMe === 'object') {
      const del = deleteSyncEvent(sm.deleteForMe);
      if (del) out.push(del);
    }
    if (!out.length) dbg('normalize: unhandled sync message ' + Object.keys(sm).join(','));
    return out;
  }

  dbg('normalize: unhandled envelope ' + Object.keys(env).join(','));
  return [];
}
