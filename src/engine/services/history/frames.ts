/* Frames of a link-and-sync archive to what Beacon stores, following Signal-Desktop's backups/import. Recipients and chats come before the chat items that name them, so the mapper remembers them as it goes. */

import { fromBinary } from '@bufbuild/protobuf';

import { toBase64 } from '../../bytes';
import {
  BackupInfoSchema,
  type Chat,
  type ChatItem,
  type Contact,
  FrameSchema,
  type Group,
  type SendStatus,
} from '../../gen/Backups_pb';
import { attachmentJson, contactCardJson, reactionsOf, type RecipientLookup, standardJson, textInto, uuidOf } from './frame-content';
import { updateInto } from './frame-updates';
import type { CreateFrameMapper, HistoryChat, HistoryContact, HistoryGroup, HistoryItem, HistoryMessage, HistorySelf, HistoryStatus } from './types';

const BACKUP_VERSION = 1n;
const MUTED_ALWAYS = Number.MAX_SAFE_INTEGER;
const INT64_MAX = 9223372036854775807n;

type Where = { convId: string; groupInternalId: string | null };
type Person = { key: string; aci: string };

function contactName(c: Contact): string {
  const nick = c.nickname ? [c.nickname.given, c.nickname.family].filter(Boolean).join(' ') : '';
  const system = [c.systemGivenName, c.systemFamilyName].filter(Boolean).join(' ');
  const profile = [c.profileGivenName, c.profileFamilyName].filter(Boolean).join(' ');
  return (nick || c.systemNickname || system || profile).slice(0, 200);
}

function e164Of(c: Contact): string {
  return c.e164 && c.e164 > 0n ? '+' + c.e164.toString() : '';
}

function groupTitle(g: Group): string {
  const t = g.snapshot && g.snapshot.title ? g.snapshot.title.content : null;
  return t && t.case === 'title' ? t.value.slice(0, 200) : '';
}

const STATUS_RANK: Record<string, number> = { failed: 0, sent: 1, delivered: 2, read: 3 };

/** Our message's status: the best any recipient reached, or failed when it reached none. */
function sendStatus(list: SendStatus[]): HistoryStatus {
  let best: HistoryStatus = list.length ? 'failed' : 'sent';
  for (const s of list) {
    const c = s.deliveryStatus.case;
    const status: HistoryStatus | null = c === 'read' || c === 'viewed' ? 'read' : c === 'delivered' ? 'delivered' : c === 'sent' || c === 'pending' || c === 'skipped' ? 'sent' : null;
    if (status && STATUS_RANK[status] > STATUS_RANK[best]) best = status;
  }
  return best;
}

function mutedUntil(ms: bigint | undefined): number {
  if (!ms || ms <= 0n) return 0;
  return ms >= INT64_MAX || ms > BigInt(Number.MAX_SAFE_INTEGER) ? MUTED_ALWAYS : Number(ms);
}

export const createFrameMapper: CreateFrameMapper = (self: HistorySelf, groupIdOf, now) => {
  const selfKey = self.e164 || self.aci;
  const people = new Map<bigint, Person>();
  const groups = new Map<bigint, string>();
  const chats = new Map<bigint, Where>();
  const chatRecipients = new Map<bigint, bigint>();
  let selfId: bigint | null = null;
  let sawInfo = false;

  const lookup: RecipientLookup = {
    keyOf: (id) => (id === selfId ? selfKey : (people.get(id) || { key: null }).key),
    aciOf: (id) => (id === selfId ? self.aci : (people.get(id) || { aci: '' }).aci),
  };

  function recipient(id: bigint, d: { case: string | undefined; value?: unknown }): HistoryItem | null {
    if (d.case === 'self') {
      selfId = id;
      return null;
    }
    if (d.case === 'contact') {
      const c = d.value as Contact;
      const aci = uuidOf(c.aci);
      const e164 = e164Of(c);
      if (!aci && !e164) return null;
      people.set(id, { key: e164 || aci, aci });
      const out: HistoryContact = { t: 'contact', aci, e164, name: contactName(c), blocked: c.blocked, whitelisted: c.profileSharing };
      if (c.profileKey && c.profileKey.length === 32) out.profileKey = toBase64(c.profileKey);
      return out;
    }
    if (d.case === 'group') {
      const g = d.value as Group;
      if (g.masterKey.length !== 32) return null;
      const groupId = groupIdOf(g.masterKey);
      groups.set(id, groupId);
      const out: HistoryGroup = { t: 'group', groupId, masterKey: toBase64(g.masterKey), title: groupTitle(g), blocked: g.blocked, whitelisted: g.whitelisted };
      return out;
    }
    return null;
  }

  function chat(c: Chat): HistoryChat | null {
    const groupId = groups.get(c.recipientId);
    const person = people.get(c.recipientId);
    const where: Where | null = groupId ? { convId: 'g:' + groupId, groupInternalId: groupId } : person ? { convId: person.key, groupInternalId: null } : c.recipientId === selfId ? { convId: selfKey, groupInternalId: null } : null;
    if (!where) return null;
    chats.set(c.id, where);
    const out: HistoryChat = {
      t: 'chat',
      ...where,
      archived: c.archived,
      pinned: c.pinnedOrder !== undefined,
      mutedUntil: mutedUntil(c.muteUntilMs),
      markedUnread: c.markedUnread,
      expireTimer: c.expirationTimerMs ? Math.floor(Number(c.expirationTimerMs) / 1000) : 0,
    };
    if (c.notifyForMentionsIfMuted !== undefined) out.mentionsIfMuted = c.notifyForMentionsIfMuted;
    if (c.notifyForRepliesIfMuted !== undefined) out.repliesIfMuted = c.notifyForRepliesIfMuted;
    if (c.notifyForCallsIfMuted !== undefined) out.callsIfMuted = c.notifyForCallsIfMuted;
    return out;
  }

  /** The message's content, set on `msg`; false for content Beacon doesn't keep. */
  function contentInto(item: ChatItem, msg: HistoryMessage): boolean {
    const it = item.item;
    switch (it.case) {
      case 'standardMessage':
        msg.dm = standardJson(it.value, lookup);
        msg.reactions = reactionsOf(it.value.reactions, lookup);
        msg.revisions = item.revisions.filter((r) => r.item.case === 'standardMessage').map((r) => ({ ...standardJson(r.item.value as any, lookup), timestamp: Number(r.dateSent) }));
        if (!msg.revisions.length) delete msg.revisions;
        return true;
      case 'contactMessage':
        if (!it.value.contact) return false;
        msg.dm = { contacts: [contactCardJson(it.value.contact)] };
        msg.reactions = reactionsOf(it.value.reactions, lookup);
        return true;
      case 'stickerMessage': {
        const s = it.value.sticker;
        const att = s && s.data ? attachmentJson({ ...s.data, contentType: s.data.contentType || 'image/webp', fileName: s.data.fileName || 'sticker.webp' } as any, false, false) : null;
        if (!att) return false;
        msg.dm = { message: s!.emoji || null, attachments: [att] };
        msg.reactions = reactionsOf(it.value.reactions, lookup);
        return true;
      }
      case 'viewOnceMessage': {
        const a = it.value.attachment;
        const att = a && a.pointer ? attachmentJson(a.pointer, false, true) : null;
        msg.dm = { viewOnce: true, attachments: [att || { id: '', contentType: 'image/jpeg', filename: '', size: 0, viewOnce: true }] };
        if (!att || !att.id) msg.viewed = true;
        msg.reactions = reactionsOf(it.value.reactions, lookup);
        return true;
      }
      case 'remoteDeletedMessage':
      case 'adminDeletedMessage':
        msg.deleted = true;
        if (it.case === 'adminDeletedMessage') msg.deletedByAdmin = true;
        msg.dm = { message: '' };
        return true;
      case 'directStoryReplyMessage': {
        const r = it.value.reply;
        const storyAuthor = msg.incoming ? self.aci : lookup.aciOf(chatRecipients.get(item.chatId) ?? -1n);
        if (r.case === 'emoji') {
          msg.notice = { kind: 'storyReaction', text: r.value.slice(0, 16) };
          return true;
        }
        if (r.case !== 'textReply') return false;
        msg.dm = { storyContext: { authorUuid: storyAuthor, sentTimestamp: 0 } };
        textInto(r.value.text, msg.dm);
        msg.reactions = reactionsOf(it.value.reactions, lookup);
        return true;
      }
      case 'poll': {
        const p = it.value;
        msg.dm = { pollCreate: { question: p.question, options: p.options.map((o) => o.option), allowMultiple: p.allowMultiple } };
        msg.reactions = reactionsOf(p.reactions, lookup);
        const votes: Record<string, { options: number[]; voteCount: number }> = {};
        p.options.forEach((o, i) => {
          for (const v of o.votes) {
            const key = lookup.keyOf(v.voterId);
            if (!key) continue;
            const vote = votes[key] || (votes[key] = { options: [], voteCount: v.voteCount });
            vote.options.push(i);
          }
        });
        msg.pollVotes = votes;
        if (p.hasEnded) msg.pollEnded = true;
        return true;
      }
      case 'paymentNotification':
        msg.notice = { kind: 'payment', value: 'notification' };
        return true;
      case 'updateMessage':
        return updateInto(it.value, msg, !!chats.get(item.chatId)?.groupInternalId);
      default:
        return false;
    }
  }

  function chatItem(item: ChatItem): HistoryMessage | null {
    const where = chats.get(item.chatId);
    if (!where) return null;
    const d = item.directionalDetails;
    const incoming = d.case !== 'outgoing';
    const author = d.case === 'outgoing' ? selfKey : lookup.keyOf(item.authorId) || '';
    const expiresInMs = item.expiresInMs ? Number(item.expiresInMs) : 0;
    const expireStart = item.expireStartDate ? Number(item.expireStartDate) : 0;
    if (expiresInMs && expireStart && expireStart + expiresInMs <= now) return null;
    const msg: HistoryMessage = {
      t: 'message',
      ...where,
      incoming,
      author,
      timestamp: Number(item.dateSent),
      read: d.case === 'incoming' ? d.value.read : true,
      status: d.case === 'outgoing' ? sendStatus(d.value.sendStatus) : 'received',
      reactions: {},
    };
    if (expiresInMs) {
      msg.expireSecs = Math.floor(expiresInMs / 1000);
      msg.expiresAt = (expireStart || now) + expiresInMs;
    }
    const pin = item.pinDetails;
    if (pin && (pin.pinExpiry.case === 'pinNeverExpires' || (pin.pinExpiry.case === 'pinExpiresAtTimestamp' && Number(pin.pinExpiry.value) > now))) msg.pinned = true;
    if (!contentInto(item, msg)) return null;
    if (!msg.author && !msg.notice && !msg.groupUpdates) return null;
    return msg;
  }

  return {
    map(frame: Uint8Array): HistoryItem | null {
      if (!sawInfo) {
        const info = fromBinary(BackupInfoSchema, frame);
        if (info.version !== BACKUP_VERSION) throw Object.assign(new Error('Unsupported archive version'), { name: 'BackupUnsupported' });
        sawInfo = true;
        return null;
      }
      const f = fromBinary(FrameSchema, frame);
      switch (f.item.case) {
        case 'recipient':
          return f.item.value.destination.case ? recipient(f.item.value.id, f.item.value.destination) : null;
        case 'chat':
          chatRecipients.set(f.item.value.id, f.item.value.recipientId);
          return chat(f.item.value);
        case 'chatItem':
          return chatItem(f.item.value);
        default:
          return null;
      }
    },
  };
};
