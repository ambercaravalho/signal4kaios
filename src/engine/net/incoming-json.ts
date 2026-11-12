/* Decrypted Content to the JSON frames the app's normalizer (`src/ui/data/normalize.ts`) consumes. Every field is copied from an untrusted message, so lengths and shapes are checked here or there. */

import { toBase64 } from '../bytes';
import {
  type AddressableMessage,
  type AttachmentPointer,
  AttachmentPointer_Flags,
  BodyRange_Style,
  CallMessage_Offer_Type,
  type Content,
  type ConversationIdentifier,
  type DataMessage,
  DataMessage_Flags,
  type DataMessage_Payment,
  DataMessage_Payment_Activation_Type,
  Envelope_Type,
  ReceiptMessage_Type,
  type SyncMessage_AttachmentBackfillResponse,
  SyncMessage_AttachmentBackfillResponse_AttachmentData_Status,
  SyncMessage_MessageRequestResponse_Type,
  TypingMessage_Action,
} from '../gen/SignalService_pb';
import { receivedMeta } from '../services/attachment-meta';
import { groupIdFromMasterKey } from '../services/groups-v2';
import { isValidLinkPreview } from '../services/link-previews';
import { POLL_OPTIONS_MAX, POLL_QUESTION_MAX_RECEIVE, validPoll } from '../services/polls';
import { encodeAttachmentDescriptor } from './attachment-descriptor';
import { isAci, num, serviceIdFrom } from './proto';
import type { IncomingEnvelope } from './receive';

export { type AttachmentDescriptor, decodeAttachmentDescriptor } from './attachment-descriptor';

const MAX_CONTACT_CARDS = 5;
const MAX_CARD_FIELDS = 5;
const MAX_PREVIEW_TEXT = 300;
const MAX_BACKFILL_SLOTS = 100;

const REQUEST_RESPONSES: Record<number, string> = {
  [SyncMessage_MessageRequestResponse_Type.ACCEPT]: 'accept',
  [SyncMessage_MessageRequestResponse_Type.DELETE]: 'delete',
  [SyncMessage_MessageRequestResponse_Type.BLOCK]: 'block',
  [SyncMessage_MessageRequestResponse_Type.BLOCK_AND_DELETE]: 'blockAndDelete',
  [SyncMessage_MessageRequestResponse_Type.SPAM]: 'spam',
  [SyncMessage_MessageRequestResponse_Type.BLOCK_AND_SPAM]: 'blockAndSpam',
};

const MAX_REPORT_TOKEN_BYTES = 1024;

export function attachmentCdnKey(att: AttachmentPointer): string {
  const id = att.attachmentIdentifier;
  if (id.case === 'cdnKey') return id.value;
  if (id.case === 'cdnId') return id.value.toString();
  return '';
}

export function pointerDescriptor(att: AttachmentPointer, contentType: string, fileName: string): string {
  return encodeAttachmentDescriptor({ cdnKey: attachmentCdnKey(att), cdnNumber: att.cdnNumber || 0, key: att.key, digest: att.digest, contentType, fileName, size: att.size || 0 });
}

function attachmentJson(ptr: AttachmentPointer, contentType: string, fileName: string, viewOnce: boolean) {
  return {
    id: pointerDescriptor(ptr, contentType, fileName),
    contentType,
    filename: fileName,
    size: ptr.size || 0,
    voiceNote: ((ptr.flags || 0) & AttachmentPointer_Flags.VOICE_MESSAGE) !== 0,
    viewOnce,
    ...receivedMeta(ptr),
  };
}

/** A backfill answer's attachment slots: a fresh pointer, `pending` while the phone uploads, or `failed`. Null when the phone no longer has the message. */
function backfillSlots(r: SyncMessage_AttachmentBackfillResponse): Array<ReturnType<typeof attachmentJson> | 'pending' | 'failed'> | null {
  if (r.data.case !== 'attachments') return null;
  return r.data.value.attachments.slice(0, MAX_BACKFILL_SLOTS).map((d) => {
    if (d.data.case === 'attachment') {
      const p = d.data.value;
      return attachmentJson(p, p.contentType || 'application/octet-stream', p.fileName || '', false);
    }
    return d.data.case === 'status' && d.data.value === SyncMessage_AttachmentBackfillResponse_AttachmentData_Status.PENDING ? 'pending' : 'failed';
  });
}

function styleName(style: BodyRange_Style): string | null {
  switch (style) {
    case BodyRange_Style.BOLD: return 'BOLD';
    case BodyRange_Style.ITALIC: return 'ITALIC';
    case BodyRange_Style.SPOILER: return 'SPOILER';
    case BodyRange_Style.STRIKETHROUGH: return 'STRIKETHROUGH';
    case BodyRange_Style.MONOSPACE: return 'MONOSPACE';
    default: return null;
  }
}

function groupInfoFor(masterKey: Uint8Array | undefined): { groupId: string } | undefined {
  if (!masterKey || masterKey.length !== 32) return undefined;
  try {
    return { groupId: groupIdFromMasterKey(masterKey) };
  } catch {
    return undefined;
  }
}

function convertDataMessageToNormalizeJson(dm: DataMessage, fallbackTs?: number): any {
  const mentions: Array<{ start: number; length: number; uuid: string }> = [];
  const textStyles: Array<{ start: number; length: number; style: string }> = [];

  for (const br of dm.bodyRanges) {
    const start = br.start || 0;
    const length = br.length || 1;
    const v = br.associatedValue;
    if (v.case === 'mentionAci' || v.case === 'mentionAciBinary') {
      const uuid = v.case === 'mentionAci' ? v.value : serviceIdFrom(undefined, v.value);
      if (uuid) mentions.push({ start, length, uuid });
    } else if (v.case === 'style') {
      const st = styleName(v.value);
      if (st) textStyles.push({ start, length, style: st });
    }
  }

  const rawAttachments = dm.attachments.map((a) => ({
    ptr: a,
    contentType: a.contentType || 'application/octet-stream',
    fileName: a.fileName || '',
  }));
  if (dm.sticker && dm.sticker.data) {
    const st = dm.sticker.data;
    rawAttachments.unshift({ ptr: st, contentType: st.contentType || 'image/webp', fileName: st.fileName || 'sticker.webp' });
  }

  const out: any = {
    timestamp: num(dm.timestamp) || fallbackTs || Date.now(),
    message: dm.body || (dm.sticker && dm.sticker.emoji ? dm.sticker.emoji : null),
    expiresInSeconds: dm.expireTimer || 0,
    viewOnce: !!dm.isViewOnce,
    mentions,
    textStyles,
    groupInfo: groupInfoFor(dm.groupV2 && dm.groupV2.masterKey),
    attachments: rawAttachments.map((a) => attachmentJson(a.ptr, a.contentType, a.fileName, !!dm.isViewOnce)),
  };

  if (dm.contact.length > 0) {
    out.contacts = dm.contact.slice(0, MAX_CONTACT_CARDS).map((c) => {
      const n = c.name;
      const name = n ? n.nickname || [n.prefix, n.givenName, n.middleName, n.familyName, n.suffix].filter(Boolean).join(' ') : '';
      return {
        name: name || c.organization || '',
        phones: c.number.map((p) => p.value).filter(Boolean).slice(0, MAX_CARD_FIELDS),
        emails: c.email.map((e) => e.value).filter(Boolean).slice(0, MAX_CARD_FIELDS),
      };
    });
  }

  const preview = dm.preview.find((p) => (p.title || p.image) && isValidLinkPreview(p.url, dm.body || ''));
  if (preview) {
    const img = preview.image && attachmentCdnKey(preview.image) && (preview.image.contentType || '').indexOf('image/') === 0 ? preview.image : undefined;
    out.preview = {
      url: preview.url,
      title: (preview.title || '').slice(0, MAX_PREVIEW_TEXT),
      description: (preview.description || '').slice(0, MAX_PREVIEW_TEXT),
      image: img
        ? { id: pointerDescriptor(img, img.contentType, img.fileName || ''), contentType: img.contentType, filename: img.fileName || '', size: img.size || 0 }
        : undefined,
    };
  }

  if (dm.quote) {
    out.quote = {
      id: num(dm.quote.id),
      authorUuid: serviceIdFrom(dm.quote.authorAci, dm.quote.authorAciBinary) || undefined,
      text: dm.quote.text || '',
      attachments: dm.quote.attachments.map((a) => ({ contentType: a.contentType || '', filename: a.fileName || '' })),
    };
  }

  if (dm.reaction) {
    out.reaction = {
      emoji: dm.reaction.emoji || '',
      isRemove: !!dm.reaction.remove,
      targetAuthorUuid: serviceIdFrom(dm.reaction.targetAuthorAci, dm.reaction.targetAuthorAciBinary) || undefined,
      targetSentTimestamp: num(dm.reaction.targetSentTimestamp),
    };
  }

  if (dm.delete) {
    out.remoteDelete = { timestamp: num(dm.delete.targetSentTimestamp) };
  }

  if (dm.adminDelete) {
    out.adminDelete = {
      targetAuthorUuid: serviceIdFrom(undefined, dm.adminDelete.targetAuthorAciBinary) || undefined,
      targetSentTimestamp: num(dm.adminDelete.targetSentTimestamp),
    };
  }

  const pin = dm.pinMessage || dm.unpinMessage;
  if (pin) {
    const target = {
      targetAuthorUuid: serviceIdFrom(undefined, pin.targetAuthorAciBinary) || undefined,
      targetSentTimestamp: num(pin.targetSentTimestamp),
    };
    if (dm.pinMessage) out.pinMessage = target;
    else out.unpinMessage = target;
  }

  if (dm.pollCreate) {
    const p = dm.pollCreate;
    if (validPoll(p.question || '', p.options, POLL_QUESTION_MAX_RECEIVE)) out.pollCreate = { question: p.question, options: p.options.slice(), allowMultiple: !!p.allowMultiple };
  }

  if (dm.pollVote) {
    const v = dm.pollVote;
    const indexes = v.optionIndexes.slice();
    if (indexes.length <= POLL_OPTIONS_MAX && indexes.every((i) => i < POLL_OPTIONS_MAX)) {
      out.pollVote = {
        targetAuthorUuid: serviceIdFrom(undefined, v.targetAuthorAciBinary) || undefined,
        targetSentTimestamp: num(v.targetSentTimestamp),
        optionIndexes: indexes,
        voteCount: v.voteCount || 0,
      };
    }
  }

  if (dm.pollTerminate) out.pollTerminate = { targetSentTimestamp: num(dm.pollTerminate.targetSentTimestamp) };

  if ((dm.flags & DataMessage_Flags.EXPIRATION_TIMER_UPDATE) !== 0) out.expirationTimerUpdate = true;
  if (dm.groupCallUpdate) out.groupCallUpdate = true;

  if (dm.storyContext) {
    out.storyContext = {
      authorUuid: serviceIdFrom(dm.storyContext.authorAci, dm.storyContext.authorAciBinary) || undefined,
      sentTimestamp: num(dm.storyContext.sentTimestamp),
    };
  }

  const payment = dm.payment && paymentKind(dm.payment);
  if (payment) out.payment = { kind: payment };

  return out;
}

/** Which kind of payment event this is; Beacon only points to the phone, so receipts, amounts, and notes stay behind. */
function paymentKind(p: DataMessage_Payment): string | undefined {
  if (p.Item.case === 'notification') return 'notification';
  if (p.Item.case === 'activation') return p.Item.value.type === DataMessage_Payment_Activation_Type.ACTIVATED ? 'activated' : 'activationRequest';
  return undefined;
}

/** A sync message's chat: `{ groupId }` (internal ID, base64) or `{ uuid }` / `{ number }` for a person. */
function chatRef(c: ConversationIdentifier | undefined): { groupId?: string; uuid?: string; number?: string } {
  const id = c && c.identifier;
  if (!id) return {};
  switch (id.case) {
    case 'threadGroupId':
      return id.value.length ? { groupId: toBase64(id.value) } : {};
    case 'threadServiceId':
      return { uuid: id.value };
    case 'threadServiceIdBinary':
      return { uuid: serviceIdFrom(undefined, id.value) };
    case 'threadE164':
      return { number: id.value };
    default:
      return {};
  }
}

function messageRef(m: AddressableMessage): { author: string; timestamp: number } {
  const a = m.author;
  const author = a.case === 'authorServiceId' ? a.value : a.case === 'authorServiceIdBinary' ? serviceIdFrom(undefined, a.value) : a.case === 'authorE164' ? a.value : '';
  return { author, timestamp: num(m.sentTimestamp) };
}

/**
 * Convert a decrypted Signal Content + Envelope metadata into the JSON frame format consumed by the app's `parseFrame`.
 */
export function contentToNormalizedFrame(env: IncomingEnvelope, content: Content): { envelope: any } {
  const frameEnv: any = {
    source: env.sourceE164 || env.sourceUuid || '',
    sourceNumber: env.sourceE164 || undefined,
    sourceUuid: env.sourceUuid || undefined,
    sourceDevice: env.sourceDevice || 1,
    timestamp: env.timestamp || Date.now(),
  };
  if (env.type === Envelope_Type.UNIDENTIFIED_SENDER) frameEnv.sealed = true;
  if (isAci(env.serverGuid)) frameEnv.serverGuid = env.serverGuid.toLowerCase();
  // SECURITY-REVIEW: the reporting token is a server credential for spam reports; it travels to the store but is never logged.
  if (env.reportSpamToken && env.reportSpamToken.length > 0 && env.reportSpamToken.length <= MAX_REPORT_TOKEN_BYTES) frameEnv.reportSpamToken = toBase64(env.reportSpamToken);
  const c = content.content;

  switch (c.case) {
    case 'dataMessage':
      frameEnv.dataMessage = convertDataMessageToNormalizeJson(c.value, env.timestamp);
      break;
    case 'callMessage':
      if (c.value.offer) {
        frameEnv.notice = {
          kind: 'missedCall',
          video: c.value.offer.type === CallMessage_Offer_Type.OFFER_VIDEO_CALL,
          timestamp: env.timestamp || Date.now(),
        };
      }
      break;
    case 'editMessage':
      frameEnv.editMessage = {
        targetSentTimestamp: num(c.value.targetSentTimestamp),
        dataMessage: c.value.dataMessage ? convertDataMessageToNormalizeJson(c.value.dataMessage, env.timestamp) : {},
      };
      break;
    case 'typingMessage':
      frameEnv.typingMessage = {
        timestamp: num(c.value.timestamp) || env.timestamp || Date.now(),
        action: c.value.action === TypingMessage_Action.STOPPED ? 'STOPPED' : 'STARTED',
        groupId: c.value.groupId.length ? toBase64(c.value.groupId) : undefined,
      };
      break;
    case 'receiptMessage':
      frameEnv.receiptMessage = {
        when: env.timestamp || Date.now(),
        isDelivery: c.value.type === ReceiptMessage_Type.DELIVERY,
        isRead: c.value.type === ReceiptMessage_Type.READ,
        isViewed: c.value.type === ReceiptMessage_Type.VIEWED,
        timestamps: c.value.timestamp.map((t) => num(t)),
      };
      break;
    case 'syncMessage': {
      const sm = c.value;
      const syncOut: any = {};
      if (sm.content.case === 'sent') {
        const s = sm.content.value;
        const destination = serviceIdFrom(s.destinationServiceId, s.destinationServiceIdBinary) || s.destinationE164 || '';
        if (s.editMessage) {
          const innerDm = s.editMessage.dataMessage ? convertDataMessageToNormalizeJson(s.editMessage.dataMessage, num(s.timestamp)) : {};
          syncOut.sentMessage = {
            destination,
            destinationNumber: s.destinationE164 || undefined,
            destinationUuid: destination && isAci(destination) ? destination : undefined,
            timestamp: num(s.timestamp) || env.timestamp || Date.now(),
            groupInfo: innerDm.groupInfo,
            editMessage: {
              targetSentTimestamp: num(s.editMessage.targetSentTimestamp),
              dataMessage: innerDm,
            },
          };
        } else if (s.message) {
          const innerDm = convertDataMessageToNormalizeJson(s.message, num(s.timestamp));
          syncOut.sentMessage = {
            ...innerDm,
            destination,
            destinationNumber: s.destinationE164 || undefined,
            destinationUuid: destination && isAci(destination) ? destination : undefined,
            timestamp: num(s.timestamp) || innerDm.timestamp || Date.now(),
            sealed: s.unidentifiedStatus.length > 0 && s.unidentifiedStatus.every((u) => !!u.unidentified),
          };
        }
      }
      const ref = (r: { senderAci: string; senderAciBinary: Uint8Array; timestamp: bigint }) => {
        const sender = serviceIdFrom(r.senderAci, r.senderAciBinary);
        return { sender, senderUuid: sender || undefined, timestamp: num(r.timestamp) };
      };
      if (sm.read.length > 0) syncOut.readMessages = sm.read.map(ref);
      if (sm.viewed.length > 0) syncOut.viewedMessages = sm.viewed.map(ref);
      if (sm.content.case === 'viewOnceOpen') syncOut.viewOnceOpen = ref(sm.content.value);
      if (sm.content.case === 'messageRequestResponse') {
        const r = sm.content.value;
        syncOut.messageRequestResponse = {
          threadUuid: serviceIdFrom(r.threadAci, r.threadAciBinary) || undefined,
          groupId: r.groupId.length ? toBase64(r.groupId) : undefined,
          type: REQUEST_RESPONSES[r.type] || 'unknown',
        };
      }
      if (sm.content.case === 'deleteForMe') {
        const d = sm.content.value;
        syncOut.deleteForMe = {
          messages: d.messageDeletes.map((md) => ({ conversation: chatRef(md.conversation), messages: md.messages.map(messageRef) })),
          conversations: d.conversationDeletes
            .map((cd) => ({
              conversation: chatRef(cd.conversation),
              mostRecent: cd.mostRecentMessages.map(messageRef),
              mostRecentNonExpiring: cd.mostRecentNonExpiringMessages.map(messageRef),
              isFullDelete: !!cd.isFullDelete,
            }))
            .concat(d.localOnlyConversationDeletes.map((ld) => ({ conversation: chatRef(ld.conversation), mostRecent: [], mostRecentNonExpiring: [], isFullDelete: true }))),
        };
      }
      if (sm.content.case === 'attachmentBackfillResponse') {
        const r = sm.content.value;
        syncOut.attachmentBackfill = {
          conversation: chatRef(r.targetConversation),
          message: r.targetMessage ? messageRef(r.targetMessage) : null,
          attachments: backfillSlots(r),
        };
      }
      frameEnv.syncMessage = syncOut;
      break;
    }
    default:
      break;
  }

  return { envelope: frameEnv };
}
