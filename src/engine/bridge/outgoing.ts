/* Everything the app sends: messages and edits, reactions, deletes, pins, polls, typing, receipts, and the disappearing-message timer. */

import type { MessageInitShape } from '@bufbuild/protobuf';

import { bytesToBlob, fromBase64, uuidToBytes } from '../bytes';
import {
  type AttachmentPointer,
  AttachmentPointer_Flags,
  BodyRange_Style,
  BodyRangeSchema,
  ContentSchema,
  DataMessage_Flags,
  PreviewSchema,
  ReceiptMessage_Type,
  TypingMessage_Action,
} from '../gen/SignalService_pb';
import { create, isAci } from '../net/proto';
import { applyAttachmentMeta, type AttachmentMeta } from '../services/attachment-meta';
import { previewFieldsForSend } from '../services/link-previews';
import { POLL_QUESTION_MAX_SEND, validPoll } from '../services/polls';
import { isBlockedRecipient } from './blocked';
import { client, store } from './context';
import { contactIds, resolveAci, updateSyncedContact } from './contacts';
import {
  addressableMessages,
  type AddressableMessageInit,
  authorAci,
  conversationIdentifier,
  type ConversationIdentifierInit,
  deliver,
  groupTargets,
  type MessageRef,
  sendDataMessage,
} from './delivery';

type BodyRangeInit = MessageInitShape<typeof BodyRangeSchema>;
type PreviewInit = MessageInitShape<typeof PreviewSchema>;

/** Signal-Desktop's composer limit. */
const MAX_ATTACHMENTS = 32;
const MAX_PREVIEW_IMAGE_BYTES = 1024 * 1024;

export interface SendPayload {
  recipients: string[];
  message?: string;
  styles?: Array<{ start: number; length: number; style: string }>;
  expire_timer?: number;
  quote_timestamp?: number;
  quote_author?: string;
  quote_message?: string;
  quote_attachments?: Array<{ contentType: string; filename: string }>;
  base64_attachments?: string[];
  /** Per attachment, in the same order: a recorded voice message's flag, waveform, and length. */
  attachment_meta?: Array<AttachmentMeta | null>;
  edit_timestamp?: number;
  mentions?: Array<{ start: number; length: number; uuid: string }>;
  view_once?: boolean;
  poll?: { question: string; options: string[]; allow_multiple: boolean };
  preview?: { url: string; title: string; description?: string; date?: number; image?: string };
}

function parseDataUri(dataUri: string): { contentType: string; filename?: string; bytes: Uint8Array } {
  const comma = dataUri.indexOf(',');
  if (comma < 0) {
    return { contentType: 'application/octet-stream', bytes: fromBase64(dataUri) };
  }
  const header = dataUri.slice(0, comma);
  const b64 = dataUri.slice(comma + 1);
  const mimeMatch = /^data:([^;,]+)/i.exec(header);
  const fnMatch = /;filename=([^;,]+)/i.exec(header);
  return {
    contentType: mimeMatch ? mimeMatch[1] : 'application/octet-stream',
    filename: fnMatch ? fnMatch[1] : undefined,
    bytes: fromBase64(b64),
  };
}

async function outgoingPreview(p: SendPayload['preview'], body: string, hasAttachments: boolean): Promise<PreviewInit | null> {
  const fields = previewFieldsForSend(p, body, hasAttachments);
  if (!fields || !p) return null;
  const out: PreviewInit = { ...fields };
  if (p.image) {
    const { contentType, bytes } = parseDataUri(p.image);
    if (contentType.indexOf('image/') === 0 && bytes.length > 0 && bytes.length <= MAX_PREVIEW_IMAGE_BYTES) {
      out.image = await client.uploadAttachment(bytes, contentType, 'preview.' + (contentType.split('/')[1] || 'jpg'));
    }
  }
  return out;
}

function stylesToBodyRanges(styles?: SendPayload['styles'], mentions?: SendPayload['mentions']): BodyRangeInit[] {
  const mapStyle = (s: string): BodyRange_Style => {
    switch ((s || '').toUpperCase()) {
      case 'BOLD': return BodyRange_Style.BOLD;
      case 'ITALIC': return BodyRange_Style.ITALIC;
      case 'SPOILER': return BodyRange_Style.SPOILER;
      case 'STRIKETHROUGH': return BodyRange_Style.STRIKETHROUGH;
      case 'MONOSPACE': return BodyRange_Style.MONOSPACE;
      default: return BodyRange_Style.NONE;
    }
  };
  const out: BodyRangeInit[] = (styles || []).map((st) => ({
    start: st.start,
    length: st.length,
    associatedValue: { case: 'style', value: mapStyle(st.style) },
  }));
  for (const m of mentions || []) {
    if (isAci(m.uuid)) out.push({ start: m.start, length: m.length, associatedValue: { case: 'mentionAci', value: m.uuid } });
  }
  return out;
}

async function uploadAttachments(payload: SendPayload): Promise<AttachmentPointer[]> {
  const files = payload.base64_attachments || [];
  if (files.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} attachments per message`);
  const out: AttachmentPointer[] = [];
  for (let i = 0; i < files.length; i++) {
    const { contentType, filename, bytes } = parseDataUri(files[i]);
    const meta = (payload.attachment_meta && payload.attachment_meta[i]) || null;
    const ext = contentType.split('/')[1] || 'bin';
    const ptr = await client.uploadAttachment(bytes, contentType, filename || (meta && meta.voice ? '' : `attachment.${ext}`));
    if (contentType.startsWith('audio/') && files.length === 1) ptr.flags |= AttachmentPointer_Flags.VOICE_MESSAGE;
    applyAttachmentMeta(ptr, meta);
    out.push(ptr);
  }
  return out;
}

export const outgoingMethods = {
  /**
   * Send an outgoing message, edit, or attachment. `message` is the plain body; `styles` are its formatting ranges.
   */
  async send(payload: SendPayload): Promise<{ timestamp: number; sealed: boolean }> {
    const bodyText = payload.message || '';
    const res = await sendDataMessage(
      (payload.recipients && payload.recipients[0]) || '',
      async (target) => {
        const poll = payload.poll;
        if (poll && (!target.isGroup || !validPoll(poll.question, poll.options, POLL_QUESTION_MAX_SEND))) throw new Error('Polls need a group, a question, and 2 to 10 options');
        const attachments = await uploadAttachments(payload);
        const preview = await outgoingPreview(payload.preview, bodyText, (payload.base64_attachments || []).length > 0);
        const mentions: NonNullable<SendPayload['mentions']> = [];
        for (const m of payload.mentions || []) {
          const aci = await resolveAci(m.uuid);
          if (aci) mentions.push({ start: m.start, length: m.length, uuid: aci });
        }
        const acc = await store.getAccount();
        const quoteAuthor = payload.quote_timestamp ? await resolveAci(payload.quote_author || '') : '';
        return {
          body: bodyText,
          expireTimer: payload.expire_timer || undefined,
          profileKey: acc ? acc.profileKey : undefined,
          attachments,
          bodyRanges: stylesToBodyRanges(payload.styles || [], mentions),
          isViewOnce: payload.view_once && attachments.length > 0 ? true : undefined,
          pollCreate: poll ? { question: poll.question, options: poll.options, allowMultiple: poll.allow_multiple } : undefined,
          preview: preview ? [preview] : [],
          quote: payload.quote_timestamp
            ? {
                id: BigInt(payload.quote_timestamp),
                authorAci: quoteAuthor || undefined,
                text: payload.quote_message || '',
                attachments: (payload.quote_attachments || []).map((a) => ({ contentType: a.contentType || undefined, fileName: a.filename || undefined })),
              }
            : undefined,
        };
      },
      { editTimestamp: payload.edit_timestamp }
    );
    return { timestamp: res.timestamp, sealed: res.sealed };
  },

  async sendReaction(recipient: string, targetAuthor: string, targetTimestamp: number, emoji: string, remove: boolean): Promise<void> {
    await sendDataMessage(recipient, async () => {
      const targetAuthorAci = await resolveAci(targetAuthor);
      if (!targetAuthorAci) throw new Error('No Signal account known for ' + targetAuthor);
      return { reaction: { emoji, remove, targetAuthorAci, targetSentTimestamp: BigInt(targetTimestamp) } };
    });
  },

  async sendRemoteDelete(recipient: string, targetTimestamp: number): Promise<void> {
    await sendDataMessage(recipient, () => ({ delete: { targetSentTimestamp: BigInt(targetTimestamp) } }));
  },

  /** As a group admin, delete someone else's message for everyone (Signal-Desktop's AdminDelete). Members check that we are an admin. */
  async sendAdminDelete(groupSendId: string, targetAuthor: string, targetTimestamp: number): Promise<void> {
    await sendDataMessage(
      groupSendId,
      async () => {
        const aci = await resolveAci(targetAuthor);
        if (!aci) throw new Error('No Signal account known for ' + targetAuthor);
        return { adminDelete: { targetAuthorAciBinary: uuidToBytes(aci), targetSentTimestamp: BigInt(targetTimestamp) } };
      },
      { groupOnly: 'Admin delete only works in groups' }
    );
  },

  /** Tell our other devices we deleted messages or whole chats here (Signal-Desktop's DeleteForMe sync). `chat` is the chat's send ID; a chat with no messages to name goes as a local-only delete. */
  async sendDeleteForMe(body: { messages?: Array<{ chat: string; items: MessageRef[] }>; chats?: Array<{ chat: string; mostRecent: MessageRef[]; mostRecentNonExpiring: MessageRef[] }> }): Promise<void> {
    const messageDeletes: Array<{ conversation: ConversationIdentifierInit; messages: AddressableMessageInit[] }> = [];
    for (const m of body.messages || []) {
      const conversation = await conversationIdentifier(m.chat);
      const messages = await addressableMessages(m.items);
      if (conversation && messages.length) messageDeletes.push({ conversation, messages });
    }
    const conversationDeletes: Array<{ conversation: ConversationIdentifierInit; mostRecentMessages: AddressableMessageInit[]; mostRecentNonExpiringMessages: AddressableMessageInit[]; isFullDelete: boolean }> = [];
    const localOnlyConversationDeletes: Array<{ conversation: ConversationIdentifierInit }> = [];
    for (const c of body.chats || []) {
      const conversation = await conversationIdentifier(c.chat);
      if (!conversation) continue;
      const mostRecentMessages = await addressableMessages(c.mostRecent);
      if (!mostRecentMessages.length) localOnlyConversationDeletes.push({ conversation });
      else conversationDeletes.push({ conversation, mostRecentMessages, mostRecentNonExpiringMessages: await addressableMessages(c.mostRecentNonExpiring), isFullDelete: true });
    }
    if (!messageDeletes.length && !conversationDeletes.length && !localOnlyConversationDeletes.length) return;
    await client.sendSyncMessage(
      create(ContentSchema, {
        content: { case: 'syncMessage', value: { content: { case: 'deleteForMe', value: { messageDeletes, conversationDeletes, localOnlyConversationDeletes } } } },
      })
    );
  },

  /** Pin a message for everyone in the chat (forever), or unpin it, as Signal-Desktop's PinMessage / UnpinMessage data messages. */
  async sendPin(recipient: string, targetAuthor: string, targetTimestamp: number, pin: boolean): Promise<void> {
    await sendDataMessage(recipient, async () => {
      const ref = { targetAuthorAciBinary: uuidToBytes(await authorAci(targetAuthor)), targetSentTimestamp: BigInt(targetTimestamp) };
      return {
        pinMessage: pin ? { ...ref, pinDuration: { case: 'pinDurationForever', value: true } } : undefined,
        unpinMessage: pin ? undefined : ref,
      };
    });
  },

  /** Vote in a group poll (Signal-Desktop's PollVote); `voteCount` rises with each of our votes so the newest one wins everywhere. No options clears our vote. */
  async sendPollVote(groupSendId: string, pollAuthor: string, pollTimestamp: number, optionIndexes: number[], voteCount: number): Promise<void> {
    await sendDataMessage(
      groupSendId,
      async () => ({ pollVote: { targetAuthorAciBinary: uuidToBytes(await authorAci(pollAuthor)), targetSentTimestamp: BigInt(pollTimestamp), optionIndexes, voteCount } }),
      { groupOnly: 'Polls only work in groups' }
    );
  },

  /** End our own group poll (Signal-Desktop's PollTerminate). Resolves to when it ended. */
  async sendPollTerminate(groupSendId: string, pollTimestamp: number): Promise<number> {
    const res = await sendDataMessage(groupSendId, () => ({ pollTerminate: { targetSentTimestamp: BigInt(pollTimestamp) } }), { groupOnly: 'Polls only work in groups' });
    return res.timestamp;
  },

  /** Change a 1:1 chat's disappearing-message timer with an explicit EXPIRATION_TIMER_UPDATE message and a newer `expireTimerVersion`, as Signal-Desktop does. */
  async setDirectExpireTimer(recipient: string, seconds: number): Promise<void> {
    await sendDataMessage(recipient, async (target) => {
      if (target.isGroup) throw new Error('Use the group settings to change a group timer');
      const ids = await contactIds(target.peers[0]);
      let version = 1;
      await updateSyncedContact({ aci: target.peers[0], e164: ids.e164 }, (c) => {
        version = (c.expireTimerVersion || 1) + 1;
        c.expireTimerVersion = version;
        c.expireTimer = seconds;
      });
      const acc = await store.getAccount();
      return {
        flags: DataMessage_Flags.EXPIRATION_TIMER_UPDATE,
        expireTimer: Math.max(0, Math.floor(seconds)),
        expireTimerVersion: version,
        profileKey: acc ? acc.profileKey : undefined,
      };
    });
  },

  async sendTyping(recipient: string, started: boolean): Promise<void> {
    if (await isBlockedRecipient(recipient)) return;
    const ts = Date.now();
    const target = await groupTargets(recipient);
    const content = create(ContentSchema, {
      content: {
        case: 'typingMessage',
        value: {
          timestamp: BigInt(ts),
          action: started ? TypingMessage_Action.STARTED : TypingMessage_Action.STOPPED,
          groupId: target.isGroup ? fromBase64(target.internalId) : undefined,
        },
      },
    });
    await deliver(target, content, ts, true);
  },

  async sendReadReceipt(recipient: string, timestamp: number): Promise<void> {
    const now = Date.now();
    const aci = await resolveAci(recipient);
    if (!aci || (await isBlockedRecipient(aci)) || (await isBlockedRecipient(recipient))) return;
    await client.sendContentToRecipient(
      aci,
      create(ContentSchema, { content: { case: 'receiptMessage', value: { type: ReceiptMessage_Type.READ, timestamp: [BigInt(timestamp)] } } }),
      now
    );
    await client.sendSyncMessage(
      create(ContentSchema, { content: { case: 'syncMessage', value: { read: [{ senderAci: aci, timestamp: BigInt(timestamp) }] } } }),
      now
    );
  },

  /** We opened a voice message, video, or view-once media: a VIEWED receipt to the sender when `receipt` is set, and a Viewed sync (plus ViewOnceOpen for view-once) to our other devices, as Signal-Desktop does. */
  async sendViewed(recipient: string, timestamp: number, opts: { receipt: boolean; viewOnce: boolean }): Promise<void> {
    const now = Date.now();
    const aci = await resolveAci(recipient);
    if (!aci) return;
    if (opts.receipt && !(await isBlockedRecipient(aci)) && !(await isBlockedRecipient(recipient))) {
      await client.sendContentToRecipient(
        aci,
        create(ContentSchema, { content: { case: 'receiptMessage', value: { type: ReceiptMessage_Type.VIEWED, timestamp: [BigInt(timestamp)] } } }),
        now
      );
    }
    const ref = { senderAci: aci, timestamp: BigInt(timestamp) };
    await client.sendSyncMessage(
      create(ContentSchema, {
        content: {
          case: 'syncMessage',
          value: { viewed: [ref], content: opts.viewOnce ? { case: 'viewOnceOpen', value: ref } : { case: undefined } },
        },
      }),
      now
    );
  },

  async downloadAttachmentBlob(id: string): Promise<Blob> {
    const { bytes, contentType } = await client.downloadAttachment(id);
    return bytesToBlob(bytes, contentType);
  },
};
