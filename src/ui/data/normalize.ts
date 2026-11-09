/* Turns the JSON frames the engine produces from decrypted envelopes into typed events for the store. Frames are untrusted: unknown or malformed shapes are logged and dropped, never thrown. */

import { dbg } from './log';
import type { StyleRange } from './styled';
import type { Attachment, Quote } from './types';

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
}

export type StoreEvent =
  | MessageEvent
  | { type: 'edit'; convId: string; author: string; targetTimestamp: number; newBody: string; newStyles: StyleRange[]; timestamp: number }
  | { type: 'reaction'; convId: string; reactor: string; emoji: string; remove: boolean; targetAuthor: string; targetTimestamp: number }
  | { type: 'remoteDelete'; convId: string; author: string; targetTimestamp: number }
  | { type: 'pin' | 'unpin'; convId: string; targetAuthor: string; targetTimestamp: number }
  | { type: 'timer'; convId: string; seconds: number }
  | { type: 'typing'; convId: string; author: string; started: boolean }
  | { type: 'receipt'; peer: string; kind: 'read' | 'delivery' | 'other'; timestamps: number[] }
  | { type: 'readSync'; entries: Array<{ sender: string; timestamp: number }> };

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

function quoteOf(dm: any): Quote | null {
  const q = dm.quote;
  if (!q || typeof q !== 'object') return null;
  return { author: str(q.authorNumber) || str(q.authorUuid) || str(q.author), timestamp: num(q.id) || num(q.timestamp), text: str(q.text) };
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

  if (dm.expirationTimerUpdate) return [{ type: 'timer', convId, seconds: num(dm.expiresInSeconds) }];

  const attachments: any[] = Array.isArray(dm.attachments) ? dm.attachments : [];
  const body = dm.message;
  if (body == null && attachments.length === 0 && !dm.sticker) {
    dbg('normalize: message without text');
    return [];
  }

  return [
    {
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
    },
  ];
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
    return [{ type: 'receipt', peer, kind: rm.isRead ? 'read' : rm.isDelivery ? 'delivery' : 'other', timestamps }];
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
    if (Array.isArray(sm.readMessages)) {
      const entries: Array<{ sender: string; timestamp: number }> = [];
      for (const r of sm.readMessages) {
        const sender = str(r.senderNumber) || str(r.senderUuid) || str(r.sender);
        if (sender && r.timestamp) entries.push({ sender, timestamp: num(r.timestamp) });
      }
      return entries.length ? [{ type: 'readSync', entries }] : [];
    }
    dbg('normalize: unhandled sync message ' + Object.keys(sm).join(','));
    return [];
  }

  dbg('normalize: unhandled envelope ' + Object.keys(env).join(','));
  return [];
}
