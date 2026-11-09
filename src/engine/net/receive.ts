/* Incoming envelope decryption, and conversion of decrypted Content into the JSON frames the app's normalizer consumes.
 *
 * Bridges Signal wire messages (Envelope + Content protobufs, generated from Signal-Desktop's SignalService.proto) to the JSON envelope structure consumed by the app's normalizer and store.
 */

import { fromBase64, toBase64 } from '../bytes';
import { unpadMessagePlaintext } from '../crypto/primitives';
import {
  AttachmentPointer,
  AttachmentPointer_Flags,
  BodyRange_Style,
  CallMessage_Offer_Type,
  ContactDetailsSchema,
  Content,
  ContentSchema,
  DataMessage,
  DataMessage_Flags,
  Envelope_Type,
  EnvelopeSchema,
  ReceiptMessage_Type,
  TypingMessage_Action,
} from '../gen/SignalService_pb';
import { groupIdFromMasterKey } from '../services/groups-v2';
import { create, fromBinary, num, readDelimited, serviceIdFrom } from './proto';
import {
  archiveSession,
  CIPHERTEXT_PLAINTEXT,
  CIPHERTEXT_PREKEY,
  CIPHERTEXT_SENDERKEY,
  CIPHERTEXT_WHISPER,
  decryptPreKey,
  decryptSenderKey,
  decryptWhisper,
  errorCode,
  localIdentity,
  LocalIdentity,
  parseDecryptionErrorMessage,
  plaintextContentBody,
  processSenderKeyDistribution,
  unseal,
} from '../protocol/protocol';
import type { SignalProtocolStore } from '../protocol/store';
import { isAci } from './proto';

/** Envelope metadata after decryption; `sourceUuid` is the sender's service ID (from Sealed Sender when the envelope is sealed). */
export interface IncomingEnvelope {
  type: number;
  sourceUuid: string;
  sourceE164?: string;
  sourceDevice: number;
  destinationServiceId: string;
  timestamp: number;
  serverTimestamp: number;
  serverGuid: string;
}

export function attachmentCdnKey(att: AttachmentPointer): string {
  const id = att.attachmentIdentifier;
  if (id.case === 'cdnKey') return id.value;
  if (id.case === 'cdnId') return id.value.toString();
  return '';
}

function encodeAttachmentDescriptor(att: AttachmentPointer, contentType: string, fileName: string): string {
  const meta = {
    cdnKey: attachmentCdnKey(att),
    cdnNumber: att.cdnNumber || 0,
    key: toBase64(att.key),
    digest: att.digest.length ? toBase64(att.digest) : '',
    contentType,
    fileName,
    size: att.size || 0,
  };
  return 's4katt:' + toBase64(new TextEncoder().encode(JSON.stringify(meta)));
}

export interface AttachmentDescriptor {
  cdnKey: string;
  cdnNumber: number;
  key: Uint8Array;
  digest?: Uint8Array;
  contentType: string;
  fileName: string;
  size: number;
}

export function decodeAttachmentDescriptor(id: string): AttachmentDescriptor | null {
  if (!id || !id.startsWith('s4katt:')) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64(id.slice(7))));
    if (typeof parsed.cdnKey !== 'string' || !parsed.cdnKey) return null;
    return {
      cdnKey: parsed.cdnKey,
      cdnNumber: typeof parsed.cdnNumber === 'number' ? parsed.cdnNumber : 0,
      key: fromBase64(parsed.key || ''),
      digest: parsed.digest ? fromBase64(parsed.digest) : undefined,
      contentType: parsed.contentType || 'application/octet-stream',
      fileName: parsed.fileName || '',
      size: typeof parsed.size === 'number' ? parsed.size : 0,
    };
  } catch {
    return null;
  }
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
    rawAttachments.push({ ptr: st, contentType: st.contentType || 'image/webp', fileName: st.fileName || 'sticker.webp' });
  }

  const out: any = {
    timestamp: num(dm.timestamp) || fallbackTs || Date.now(),
    message: dm.body || (dm.sticker && dm.sticker.emoji ? dm.sticker.emoji : null),
    expiresInSeconds: dm.expireTimer || 0,
    viewOnce: !!dm.isViewOnce,
    mentions,
    textStyles,
    groupInfo: groupInfoFor(dm.groupV2 && dm.groupV2.masterKey),
    attachments: rawAttachments.map((a) => ({
      id: encodeAttachmentDescriptor(a.ptr, a.contentType, a.fileName),
      contentType: a.contentType,
      filename: a.fileName,
      size: a.ptr.size || 0,
      voiceNote: ((a.ptr.flags || 0) & AttachmentPointer_Flags.VOICE_MESSAGE) !== 0,
      viewOnce: !!dm.isViewOnce,
    })),
  };

  if (dm.quote) {
    out.quote = {
      id: num(dm.quote.id),
      authorUuid: serviceIdFrom(dm.quote.authorAci, dm.quote.authorAciBinary) || undefined,
      text: dm.quote.text || '',
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

  const pin = dm.pinMessage || dm.unpinMessage;
  if (pin) {
    const target = {
      targetAuthorUuid: serviceIdFrom(undefined, pin.targetAuthorAciBinary) || undefined,
      targetSentTimestamp: num(pin.targetSentTimestamp),
    };
    if (dm.pinMessage) out.pinMessage = target;
    else out.unpinMessage = target;
  }

  if ((dm.flags & DataMessage_Flags.EXPIRATION_TIMER_UPDATE) !== 0) out.expirationTimerUpdate = true;

  return out;
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
          };
        }
      }
      if (sm.read.length > 0) {
        syncOut.readMessages = sm.read.map((r) => {
          const sender = serviceIdFrom(r.senderAci, r.senderAciBinary);
          return { sender, senderUuid: sender || undefined, timestamp: num(r.timestamp) };
        });
      }
      frameEnv.syncMessage = syncOut;
      break;
    }
    default:
      break;
  }

  return { envelope: frameEnv };
}

/** A message that reached us but could not be decrypted. Carries what a DecryptionErrorMessage retry receipt needs. */
export class DecryptFailure extends Error {
  constructor(
    readonly cause: unknown,
    readonly senderName: string,
    readonly senderDeviceId: number,
    readonly ciphertextType: number,
    readonly ciphertext: Uint8Array,
    readonly timestamp: number
  ) {
    super('decrypt failed: ' + (errorCode(cause) || (cause instanceof Error ? cause.message : String(cause))));
    this.name = 'DecryptFailure';
  }
}

async function decryptInner(
  store: SignalProtocolStore,
  local: LocalIdentity,
  type: number,
  name: string,
  deviceId: number,
  body: Uint8Array,
  timestamp: number
): Promise<Uint8Array> {
  try {
    if (type === CIPHERTEXT_PREKEY) return (await decryptPreKey(store, local, name, deviceId, body)).plaintext;
    if (type === CIPHERTEXT_WHISPER) return (await decryptWhisper(store, local, name, deviceId, body)).plaintext;
    if (type === CIPHERTEXT_SENDERKEY) return await decryptSenderKey(store, local, name, deviceId, body);
    if (type === CIPHERTEXT_PLAINTEXT) return plaintextContentBody(body);
  } catch (e) {
    // A replayed message is not a session problem; never answer it with a retry receipt.
    if (errorCode(e) === 'DuplicatedMessage') throw e;
    throw new DecryptFailure(e, name, deviceId, type, body, timestamp);
  }
  throw new Error(`Unsupported ciphertext type ${type}`);
}

export interface DecryptedEnvelope {
  envelope: IncomingEnvelope;
  content: Content;
  normalizedFrame: { envelope: any };
}

/**
 * Decrypt a binary Signal `Envelope` into its Content and normalized JSON frame. Returns null for envelopes with nothing to show (empty, or our own device's sealed messages).
 */
export async function decryptEnvelope(store: SignalProtocolStore, envelopeBytes: Uint8Array): Promise<DecryptedEnvelope | null> {
  const raw = fromBinary(EnvelopeSchema, envelopeBytes);
  const env: IncomingEnvelope = {
    type: raw.type,
    sourceUuid: serviceIdFrom(raw.sourceServiceId, raw.sourceServiceIdBinary),
    sourceDevice: raw.sourceDeviceId || 1,
    destinationServiceId: serviceIdFrom(raw.destinationServiceId, raw.destinationServiceIdBinary),
    timestamp: num(raw.clientTimestamp),
    serverTimestamp: num(raw.serverTimestamp),
    serverGuid: raw.serverGuid,
  };
  const payload = raw.content;

  if (raw.type === Envelope_Type.SERVER_DELIVERY_RECEIPT) {
    const content = create(ContentSchema, {
      content: {
        case: 'receiptMessage',
        value: { type: ReceiptMessage_Type.DELIVERY, timestamp: raw.clientTimestamp ? [raw.clientTimestamp] : [] },
      },
    });
    return { envelope: env, content, normalizedFrame: contentToNormalizedFrame(env, content) };
  }

  if (payload.length === 0) return null;

  const acc = await store.getAccount();
  if (!acc) throw new Error('This phone is not linked to a Signal account');
  const toPni = !!acc.pni && env.destinationServiceId.replace(/^PNI:/, '') === acc.pni.replace(/^PNI:/, '');
  const local = await localIdentity(store, toPni && acc.pniIdentityKeyPair ? 'pni' : 'aci');

  let paddedPlaintext: Uint8Array;
  if (raw.type === Envelope_Type.UNIDENTIFIED_SENDER) {
    const unsealed = await unseal(store, local, payload);
    if (unsealed.senderUuid === acc.aci && unsealed.senderDeviceId === acc.deviceId) return null;
    env.sourceUuid = unsealed.senderUuid;
    env.sourceE164 = unsealed.senderE164 || undefined;
    env.sourceDevice = unsealed.senderDeviceId;
    paddedPlaintext = await decryptInner(
      store,
      local,
      unsealed.messageType,
      unsealed.senderUuid,
      unsealed.senderDeviceId,
      unsealed.contents,
      env.timestamp
    );
  } else {
    if (!env.sourceUuid) throw new Error('Identified envelope missing sourceServiceId');
    const type =
      raw.type === Envelope_Type.PREKEY_MESSAGE
        ? CIPHERTEXT_PREKEY
        : raw.type === Envelope_Type.DOUBLE_RATCHET
        ? CIPHERTEXT_WHISPER
        : raw.type === Envelope_Type.PLAINTEXT_CONTENT
        ? CIPHERTEXT_PLAINTEXT
        : -1;
    if (type < 0) throw new Error(`Unsupported envelope type ${raw.type}`);
    paddedPlaintext = await decryptInner(store, local, type, env.sourceUuid, env.sourceDevice, payload, env.timestamp);
  }

  const content = fromBinary(ContentSchema, unpadMessagePlaintext(paddedPlaintext));
  const senderId = env.sourceUuid;
  const senderDevice = env.sourceDevice;
  const c = content.content;

  if (c.case === 'dataMessage' && (c.value.flags & DataMessage_Flags.END_SESSION) !== 0) {
    await archiveSession(store, senderId, senderDevice);
  }

  // The peer could not decrypt something we sent: archive our session so the next send starts a fresh one
  if (c.case === 'decryptionErrorMessage') {
    try {
      const dem = parseDecryptionErrorMessage(c.value);
      if (dem.deviceId === acc.deviceId) await archiveSession(store, senderId, senderDevice);
    } catch {
      // malformed retry request; nothing to do
    }
  }

  if (content.senderKeyDistributionMessage.length > 0) {
    await processSenderKeyDistribution(store, local, senderId, senderDevice, content.senderKeyDistributionMessage);
  }

  return { envelope: env, content, normalizedFrame: contentToNormalizedFrame(env, content) };
}

export interface SyncedContact {
  uuid: string;
  number: string;
  name: string;
  expireTimer: number;
}

/**
 * Parse the varint-delimited ContactDetails stream from a contacts sync blob. Each record may be followed by `avatar.length` avatar bytes, which are skipped.
 */
export function parseContactsSyncBlob(blobBytes: Uint8Array): SyncedContact[] {
  const contacts: SyncedContact[] = [];
  for (const rec of readDelimited(blobBytes)) {
    let c;
    try {
      c = fromBinary(ContactDetailsSchema, rec.bytes);
    } catch {
      break;
    }
    if (c.avatar && c.avatar.length > 0) rec.skip(c.avatar.length);
    const uuid = serviceIdFrom(c.aci, c.aciBinary);
    if (uuid || c.number) {
      contacts.push({
        uuid,
        number: c.number || '',
        name: c.name || c.number || uuid,
        expireTimer: c.expireTimer || 0,
      });
    }
  }
  return contacts;
}
