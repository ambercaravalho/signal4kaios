/* Data messages, edits, and notices to store events: text, mentions, styles, quotes, attachments, previews, and polls. */

import { isBlurHash, isUuid } from '../../../engine/validate';
import { dbg } from '../log';
import type { StyleRange } from '../styled';
import type { Attachment, LinkPreview, Notice, NoticeKind, Quote } from '../types';
import { contactCardOf } from './contact';
import type { Conv, MessageEvent, NameOf, StoreEvent } from './events';
import { num, str } from './fields';

export function peerKey(env: any): string | null {
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

function stylesOf(dm: any, nameOf: NameOf): StyleRange[] {
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

export function noticeEvent(env: any, n: any, conv: Conv, author: string): StoreEvent[] {
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

export function dataMessageEvents(env: any, dm: any, incoming: boolean, nameOf: NameOf, authorOverride?: string, convOverride?: Conv): StoreEvent[] {
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

  if (dm.expirationTimerUpdate) return [{ type: 'timer', convId, seconds: num(dm.expiresInSeconds), author, timestamp: num(dm.timestamp) || num(env.timestamp) }];
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
    attachments: attachments.map((a) => attachmentOf(a, !!dm.viewOnce)),
    expiresInSeconds: num(dm.expiresInSeconds),
  };
  if (card) ev.contactCard = card;
  if (poll) ev.poll = poll;
  const mentioned = Array.isArray(dm.mentions) ? dm.mentions.map((m: any) => str(m && m.uuid)).filter(Boolean) : [];
  if (mentioned.length) ev.mentioned = mentioned;
  const preview = previewOf(dm);
  if (preview) ev.preview = preview;
  if (incoming ? env.sealed === true : dm.sealed === true) ev.sealed = true;
  if (incoming && isUuid(str(env.serverGuid))) ev.serverGuid = str(env.serverGuid);
  if (incoming && /^[A-Za-z0-9+/=]{1,2048}$/.test(str(env.reportSpamToken))) ev.reportToken = str(env.reportSpamToken);
  return [ev];
}

const MAX_WAVEFORM = 100;
const MAX_EDGE = 20000;

function attachmentOf(a: any, viewOnce: boolean): Attachment {
  const out: Attachment = { id: str(a.id), contentType: str(a.contentType), filename: str(a.filename), size: num(a.size), voiceNote: !!a.voiceNote, viewOnce: !!(a.viewOnce || viewOnce) };
  if (Array.isArray(a.waveform) && a.waveform.length) out.waveform = a.waveform.slice(0, MAX_WAVEFORM).map((v: unknown) => Math.max(0, Math.min(255, num(v))));
  const duration = Number(a.duration);
  if (isFinite(duration) && duration > 0) out.duration = duration;
  if (isBlurHash(a.blurHash)) out.blurHash = a.blurHash;
  const w = num(a.width);
  const h = num(a.height);
  if (w > 0 && h > 0 && w <= MAX_EDGE && h <= MAX_EDGE) {
    out.width = w;
    out.height = h;
  }
  return out;
}

function previewOf(dm: any): LinkPreview | null {
  const p = dm.preview;
  if (!p || typeof p !== 'object' || !/^https:\/\//i.test(str(p.url))) return null;
  const out: LinkPreview = { url: str(p.url), title: str(p.title).slice(0, 300) };
  const description = str(p.description).slice(0, 300);
  if (description) out.description = description;
  if (p.image && typeof p.image === 'object' && str(p.image.id) && str(p.image.contentType).indexOf('image/') === 0) out.image = attachmentOf(p.image, false);
  return out.title || out.image ? out : null;
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

export function editEvent(env: any, edit: any, author: string, nameOf: NameOf, convOverride?: Conv): StoreEvent[] {
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
