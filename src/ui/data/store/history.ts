/* Storing the message history the phone sent when linking: chats and messages are written in bulk, without notifications or live events, before the app first connects. Each message goes through the same normalizer as a received one. */

import type { HistoryChat, HistoryItem, HistoryMessage } from '../../../engine';
import { fromBase64 } from '../../../engine/bytes';
import { signal } from '../api';
import { config, type HistorySync } from '../config';
import { db, PRUNE_KEEP } from '../db';
import type { MessageEvent, NoticeEvent, StoreEvent } from '../normalize/events';
import { groupUpdateEvents } from '../normalize/group';
import { dataMessageEvents, noticeEvent } from '../normalize/message';
import type { Conversation, Message, Notice } from '../types';
import { ALERTING_NOTICES, messageRecord, noticeRecord } from './ingest';
import { messageText, previewOf } from './previews';
import { SELF_NAME } from './state';

const MAX_TEXT = 300;

/** One import's state: the chats as they grow, and who is who for names and message requests. */
export class HistoryImport {
  private convs = new Map<string, Conversation>();
  private names = new Map<string, string>();
  private whitelisted = new Map<string, boolean>();
  private outgoing = new Set<string>();
  private added = new Map<string, number>();

  constructor(existing: Conversation[], private selfKey: string) {
    for (const c of existing) this.convs.set(c.id, c);
  }

  private nameOf = (key: string): string => this.names.get(key) || key;

  private conv(convId: string, groupInternalId: string | null): Conversation {
    let c = this.convs.get(convId);
    if (!c) {
      c = groupInternalId
        ? { id: convId, type: 'group', groupInternalId, sendId: 'group.' + groupInternalId, name: this.names.get(convId) || 'Group', lastTs: 0, lastPreview: '', unread: 0, lastReadTs: 0 }
        : { id: convId, type: 'direct', sendId: convId, name: convId === this.selfKey ? SELF_NAME : this.nameOf(convId), lastTs: 0, lastPreview: '', unread: 0, lastReadTs: 0 };
      this.convs.set(convId, c);
    }
    return c;
  }

  private chat(h: HistoryChat): void {
    const c = this.conv(h.convId, h.groupInternalId);
    if (h.archived) c.archived = true;
    if (h.pinned) c.pinned = true;
    if (h.mutedUntil) c.mutedUntil = h.mutedUntil;
    if (h.markedUnread) c.markedUnread = true;
    if (h.expireTimer) c.expireTimer = h.expireTimer;
    if (h.mentionsIfMuted !== undefined) c.mentionsIfMuted = h.mentionsIfMuted;
    if (h.repliesIfMuted !== undefined) c.repliesIfMuted = h.repliesIfMuted;
    if (h.callsIfMuted !== undefined) c.callsIfMuted = h.callsIfMuted;
  }

  /** The notice for a timer change or ended poll, which the received-message path makes elsewhere. */
  private ownNotice(h: HistoryMessage, n: NonNullable<HistoryMessage['notice']>): NoticeEvent[] {
    const notice: Notice = { kind: n.kind === 'timer' ? 'timer' : 'pollEnded' };
    if (n.kind === 'timer') notice.seconds = Math.max(0, Math.floor(Number(n.seconds) || 0));
    else notice.text = String(n.text || '').slice(0, MAX_TEXT);
    return [{ type: 'notice', convId: h.convId, groupInternalId: h.groupInternalId, author: h.author, timestamp: h.timestamp, notice }];
  }

  private events(h: HistoryMessage): StoreEvent[] {
    const where = { convId: h.convId, groupInternalId: h.groupInternalId };
    const env = { timestamp: h.timestamp };
    if (h.groupUpdates) return h.groupInternalId ? groupUpdateEvents({ groupId: h.groupInternalId, author: h.author, timestamp: h.timestamp, changes: h.groupUpdates }) : [];
    if (h.notice) return h.notice.kind === 'timer' || h.notice.kind === 'pollEnded' ? this.ownNotice(h, h.notice) : noticeEvent(env, { ...h.notice, timestamp: h.timestamp }, where, h.author);
    if (!h.dm) return [];
    const dm = h.deleted ? { ...h.dm, message: h.dm.message || '' } : h.dm;
    return dataMessageEvents(env, { ...dm, timestamp: h.timestamp, expiresInSeconds: h.expireSecs || 0 }, h.incoming, this.nameOf, h.author, where);
  }

  private record(h: HistoryMessage, ev: MessageEvent): Message {
    const rec = messageRecord(ev);
    rec.status = h.incoming ? 'received' : h.status === 'received' ? 'sent' : h.status;
    rec.reactions = h.reactions;
    if (h.expiresAt) rec.expiresAt = h.expiresAt;
    if (h.pinned) rec.pinned = true;
    if (h.viewed) rec.viewed = true;
    if (h.deleted) {
      rec.deleted = true;
      rec.body = '';
      rec.attachments = [];
      if (h.deletedByAdmin) rec.deletedByAdmin = true;
    }
    if (rec.poll && h.pollVotes) {
      for (const key of Object.keys(h.pollVotes)) rec.poll.votes[key] = { ...h.pollVotes[key], timestamp: h.timestamp };
      if (h.pollEnded) rec.poll.ended = true;
    }
    if (h.revisions && h.revisions.length) {
      const versions = h.revisions
        .map((dm) => dataMessageEvents({ timestamp: dm.timestamp }, dm, h.incoming, this.nameOf, h.author, { convId: h.convId, groupInternalId: h.groupInternalId })[0])
        .filter((e): e is MessageEvent => !!e && e.type === 'message')
        .sort((a, b) => a.timestamp - b.timestamp);
      if (versions.length) {
        rec.history = versions.map((v) => ({ body: v.body, styles: v.styles, timestamp: v.timestamp }));
        rec.edited = true;
        rec.editedAt = h.timestamp;
      }
    }
    return rec;
  }

  private message(h: HistoryMessage, out: Message[]): void {
    for (const ev of this.events(h)) {
      const isNotice = ev.type === 'notice';
      if (!isNotice && ev.type !== 'message') continue;
      const rec = isNotice ? noticeRecord(ev) : this.record(h, ev);
      out.push(rec);
      const c = this.conv(rec.convId, h.groupInternalId);
      if (rec.timestamp >= c.lastTs) {
        c.lastTs = rec.timestamp;
        c.lastPreview = isNotice ? messageText(rec) : previewOf(rec);
      }
      const counts = isNotice ? ALERTING_NOTICES.indexOf(rec.notice!.kind) >= 0 && h.author !== this.selfKey : rec.incoming;
      if (counts && !h.read) c.unread = (c.unread || 0) + 1;
      if (!rec.incoming) this.outgoing.add(c.id);
      this.added.set(c.id, (this.added.get(c.id) || 0) + 1);
    }
  }

  /** Store one batch of items, in archive order. */
  async apply(items: HistoryItem[]): Promise<void> {
    const out: Message[] = [];
    for (const it of items) {
      if (it.t === 'contact') {
        const key = it.e164 || it.aci;
        if (it.name) for (const k of [it.e164, it.aci]) if (k) this.names.set(k, it.name);
        this.whitelisted.set(key, it.whitelisted);
      } else if (it.t === 'group') {
        if (it.title) this.names.set('g:' + it.groupId, it.title);
        this.whitelisted.set('g:' + it.groupId, it.whitelisted);
      } else if (it.t === 'chat') this.chat(it);
      else this.message(it, out);
    }
    if (out.length) await db.putMessages(out);
    for (const [id, n] of Array.from(this.added)) {
      if (n <= PRUNE_KEEP * 2) continue;
      await db.pruneConversation(id, PRUNE_KEEP);
      this.added.set(id, PRUNE_KEEP);
    }
  }

  /** Save the chats and trim each to what the app keeps. */
  async finish(): Promise<void> {
    for (const c of Array.from(this.convs.values())) {
      if (!this.added.has(c.id) && !c.pinned && !c.archived && !c.mutedUntil) continue;
      if (c.id !== this.selfKey && this.whitelisted.get(c.id) === false && !this.outgoing.has(c.id)) c.request = true;
      await db.putConversation(c);
      await db.pruneConversation(c.id, PRUNE_KEEP);
    }
  }
}

export type HistoryPhase = { step: 'waiting' } | { step: 'downloading' | 'adding'; fraction: number };
/** `done` once imported; `none` when the phone sent nothing (it chose not to, or the hour ran out); `relink` when it asked to link again. */
export type HistoryOutcome = 'done' | 'none' | 'relink';

/** Share of the "Adding messages" progress the first pass (checking the file) takes. */
const CHECK_SHARE = 0.2;

function save(h: HistorySync): HistorySync {
  config.setHistorySync(h);
  return h;
}

/** Wait for, download, and import the history the phone offered when linking, picking up where a reload left off. Rejects when `cancelled` turns true or a step fails; calling it again resumes. */
export async function runHistorySync(onPhase: (p: HistoryPhase) => void, cancelled: () => boolean): Promise<HistoryOutcome> {
  let h = config.historySync();
  if (!h) return 'none';
  if (!h.archive) {
    onPhase({ step: 'waiting' });
    const archive = await signal.waitForTransferArchive(cancelled);
    if (cancelled()) throw Object.assign(new Error('canceled'), { name: 'AbortError' });
    if (!archive) return 'none';
    if ('error' in archive) return archive.error === 'RELINK_REQUESTED' ? 'relink' : 'none';
    h = save({ ...h, archive, chunks: 0 });
  }
  if (!h.downloaded) {
    onPhase({ step: 'downloading', fraction: 0 });
    const from = h;
    const count = await signal.downloadTransferArchive(
      from.archive!,
      from.chunks || 0,
      (chunks, bytes, total) => {
        save({ ...from, chunks });
        onPhase({ step: 'downloading', fraction: total ? Math.min(1, bytes / total) : 0 });
      },
      cancelled
    );
    h = save({ ...from, chunks: count, downloaded: true });
  }
  onPhase({ step: 'adding', fraction: 0 });
  const run = new HistoryImport(await db.allConversations(), config.number());
  // SECURITY-REVIEW: the ephemeral backup key goes from config straight to the engine; it is never logged.
  await signal.importTransferArchive(
    fromBase64(h.key),
    h.chunks || 0,
    (items) => run.apply(items),
    (pass, f) => onPhase({ step: 'adding', fraction: pass === 1 ? f * CHECK_SHARE : CHECK_SHARE + f * (1 - CHECK_SHARE) }),
    cancelled
  );
  await run.finish();
  return 'done';
}

/** Forget the pending history: the key, and the downloaded archive. */
export async function endHistorySync(): Promise<void> {
  const h = config.historySync();
  config.setHistorySync(null);
  if (h && h.chunks) await signal.discardTransferArchive(h.chunks).catch(() => {});
}
