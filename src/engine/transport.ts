/* On-Device Signal Transport, Envelope Decryption Pipeline, and Outbound Fanout.
 *
 * Bridges Signal wire messages (Envelope + Content protobufs, generated from Signal-Desktop's SignalService.proto) to the JSON envelope structure consumed by App.normalize and App.store.
 */

import { constantTimeEqual, fromBase64, toBase64 } from './bytes';
import { decryptAttachment, encryptAttachment } from './crypto/attachment';
import { padMessagePlaintext, unpadMessagePlaintext } from './crypto/primitives';
import {
  AttachmentPointer,
  AttachmentPointer_Flags,
  AttachmentPointerSchema,
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
  SyncMessage_Request_Type,
  TypingMessage_Action,
} from './gen/SignalService_pb';
import { groupIdFromMasterKey } from './groups-v2';
import { libsignal } from './libsignal';
import { create, fromBinary, num, readDelimited, serviceIdFrom, toBinary } from './proto';
import {
  archiveSession,
  CIPHERTEXT_PLAINTEXT,
  CIPHERTEXT_PREKEY,
  CIPHERTEXT_SENDERKEY,
  CIPHERTEXT_WHISPER,
  decryptionErrorContent,
  decryptPreKey,
  decryptSenderKey,
  decryptWhisper,
  deleteSession,
  encryptForDevice,
  errorCode,
  hasUsableSession,
  localIdentity,
  LocalIdentity,
  parseDecryptionErrorMessage,
  parsePreKeyResponse,
  plaintextContentBody,
  processPreKeyBundle,
  processSenderKeyDistribution,
  safetyNumber,
  sealedEncryptForDevice,
  senderCertificateExpiration,
  unseal,
} from './protocol';
import type { SignalHttpJsonFn } from './provisioning';
import type { SignalProtocolStore, TrustLevel } from './storage';

export const DEFAULT_SIGNAL_SERVER = 'https://chat.signal.org';
export const DEFAULT_SIGNAL_CDN = 'https://cdn.signal.org';

/** Signal-Desktop config/production.json `cdn` map. */
export const SIGNAL_CDNS: Record<number, string> = {
  0: 'https://cdn.signal.org',
  2: 'https://cdn2.signal.org',
  3: 'https://cdn3.signal.org',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAci(id: string): boolean {
  return UUID_RE.test(id);
}

export type SignalHttpBinaryFn = (
  method: string,
  url: string,
  body?: Uint8Array | null,
  headers?: Record<string, string>,
  timeout?: number
) => Promise<Uint8Array>;

/** Raw CDN request that also exposes the status and `Location` header (resumable CDN2 uploads). */
export type SignalHttpRawFn = (
  method: string,
  url: string,
  body?: Uint8Array | null,
  headers?: Record<string, string>,
  timeout?: number
) => Promise<{ status: number; body: Uint8Array; location: string | null }>;

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

function attachmentCdnKey(att: AttachmentPointer): string {
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

  return out;
}

/**
 * Convert a decrypted Signal Content + Envelope metadata into the JSON frame format consumed by `App.normalize.parse`.
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
        const isVideo = c.value.offer.type === CallMessage_Offer_Type.OFFER_VIDEO_CALL;
        frameEnv.dataMessage = {
          timestamp: env.timestamp || Date.now(),
          message: isVideo ? '\u{1F4F9} Missed video call' : '\u{1F4DE} Missed voice call',
          expiresInSeconds: 0,
          mentions: [],
          textStyles: [],
          attachments: [],
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

/** Thrown when a recipient's identity key changed after the user marked it verified: sending waits until the user reviews the new safety number. */
export class IdentityChangedError extends Error {
  constructor(readonly recipient: string) {
    super(`Safety number with ${recipient} changed; verify it before sending`);
    this.name = 'UntrustedIdentity';
  }
}

/**
 * High-level SignalClient coordinating outbound encryption, device fanout, attachment upload/download, and identity verification.
 */
export class SignalClient {
  private deviceLists = new Map<string, number[]>();
  private profileKeys = new Map<string, Uint8Array>();
  private cachedSenderCert: { cert: Uint8Array; expiresAt: number } | null = null;
  private decryptQueue: Promise<any> = Promise.resolve();

  constructor(
    public readonly store: SignalProtocolStore,
    private readonly httpJson: SignalHttpJsonFn,
    private readonly httpBinary: SignalHttpBinaryFn,
    private readonly httpRaw?: SignalHttpRawFn,
    private readonly serverUrl = DEFAULT_SIGNAL_SERVER
  ) {}

  setPeerProfileKey(peerId: string, profileKey: Uint8Array): void {
    if (profileKey && profileKey.length === 32) {
      this.profileKeys.set(peerId, profileKey);
    }
  }

  getPeerProfileKey(peerId: string): Uint8Array | undefined {
    return this.profileKeys.get(peerId);
  }

  /** Our server-issued SenderCertificate for Sealed Sender, cached until an hour before it expires. */
  private async getSenderCertificate(): Promise<Uint8Array | null> {
    if (this.cachedSenderCert && this.cachedSenderCert.expiresAt > Date.now()) {
      return this.cachedSenderCert.cert;
    }
    try {
      const auth = await this.authHeader();
      const res = await this.httpJson('GET', '/v1/certificate/delivery?includeE164=false', null, {
        baseUrl: this.serverUrl,
        basicAuth: auth,
        timeout: 10000,
      });
      if (res && typeof res.certificate === 'string') {
        const cert = fromBase64(res.certificate);
        this.cachedSenderCert = { cert, expiresAt: senderCertificateExpiration(cert) - 3600 * 1000 };
        return cert;
      }
    } catch {
      // Fall back to identified delivery if the certificate fetch fails
    }
    return null;
  }

  /**
   * Send a PlaintextContent DecryptionErrorMessage retry receipt to the device whose message failed to decrypt, prompting it to resend over a fresh session.
   */
  async sendDecryptionErrorReceipt(failure: DecryptFailure): Promise<void> {
    if (failure.ciphertextType === CIPHERTEXT_PLAINTEXT) return;
    try {
      const auth = await this.authHeader();
      const content = decryptionErrorContent(failure.ciphertext, failure.ciphertextType, failure.timestamp, failure.senderDeviceId);
      await this.httpJson(
        'PUT',
        `/v1/messages/${encodeURIComponent(failure.senderName)}`,
        {
          messages: [
            {
              type: Envelope_Type.PLAINTEXT_CONTENT,
              destinationDeviceId: failure.senderDeviceId,
              destinationRegistrationId: await this.sessionRegistrationId(failure.senderName, failure.senderDeviceId),
              content: toBase64(content),
            },
          ],
          timestamp: Date.now(),
          online: false,
          urgent: false,
        },
        { baseUrl: this.serverUrl, basicAuth: auth, timeout: 10000 }
      );
    } catch {
      // Best-effort retry receipt
    }
  }

  private async sessionRegistrationId(name: string, deviceId: number): Promise<number> {
    const rec = await this.store.loadSession(name, deviceId);
    if (!rec) return 0;
    try {
      return libsignal.sessionRecordRemoteRegistrationId(rec);
    } catch {
      return 0;
    }
  }

  private async authHeader(): Promise<{ username: string; password: string; aci: string; number: string; deviceId: number }> {
    const acc = await this.store.getAccount();
    if (!acc) throw new Error('This phone is not linked to a Signal account');
    return {
      username: `${acc.aci}.${acc.deviceId}`,
      password: acc.password,
      aci: acc.aci,
      number: acc.number,
      deviceId: acc.deviceId,
    };
  }

  /**
   * Enqueue an incoming binary Envelope for strictly serialized decryption. Sends a DecryptionErrorMessage retry receipt when the ciphertext fails to decrypt.
   */
  enqueueDecryptEnvelope(envelopeBytes: Uint8Array): Promise<DecryptedEnvelope | null> {
    const next = this.decryptQueue.then(async () => {
      try {
        const res = await decryptEnvelope(this.store, envelopeBytes);
        const c = res && res.content.content;
        if (res && c && c.case === 'dataMessage' && c.value.profileKey.length === 32 && res.envelope.sourceUuid) {
          this.setPeerProfileKey(res.envelope.sourceUuid, c.value.profileKey);
        }
        return res;
      } catch (err) {
        if (err instanceof DecryptFailure) await this.sendDecryptionErrorReceipt(err);
        // A duplicate was already delivered and persisted: drop it so the server can delete it.
        if (errorCode(err) === 'DuplicatedMessage') return null;
        throw err;
      }
    });
    this.decryptQueue = next.catch(() => null);
    return next;
  }

  /** Saves a server-provided identity key before session setup, unless it replaces a key the user verified. */
  private async acceptBundleIdentity(recipientId: string, identityKey: Uint8Array): Promise<void> {
    const existing = await this.store.getIdentity(recipientId);
    if (existing && constantTimeEqual(existing.publicKey, identityKey)) return;
    if (existing && existing.trustLevel === 'TRUSTED_VERIFIED') {
      await this.store.setIdentityTrust(recipientId, 'UNTRUSTED');
      throw new IdentityChangedError(recipientId);
    }
    await this.store.saveIdentity(recipientId, identityKey, { uuid: recipientId });
  }

  /** Fetches PreKey bundles for `selector` (`*` or one device ID) and builds sessions; returns the device IDs that now have sessions. */
  private async fetchAndProcessBundles(recipientId: string, selector: string): Promise<number[]> {
    const auth = await this.authHeader();
    const local = await localIdentity(this.store);
    const res = await this.httpJson('GET', `/v2/keys/${encodeURIComponent(recipientId)}/${selector}`, null, {
      baseUrl: this.serverUrl,
      basicAuth: auth,
      timeout: 15000,
    });
    const bundles = parsePreKeyResponse(res);
    if (bundles.length > 0) await this.acceptBundleIdentity(recipientId, bundles[0].identityKey);
    const out: number[] = [];
    for (const b of bundles) {
      if (recipientId === auth.aci && b.deviceId === auth.deviceId) continue;
      await processPreKeyBundle(this.store, local, recipientId, b);
      out.push(b.deviceId);
    }
    return out;
  }

  /** Device IDs to send to: the cached list, else devices we hold sessions with, else everything the server knows (fetching PreKeys). */
  private async devicesFor(recipientId: string): Promise<number[]> {
    const auth = await this.authHeader();
    const notSelf = (d: number) => !(recipientId === auth.aci && d === auth.deviceId);
    const cached = this.deviceLists.get(recipientId);
    if (cached && cached.length > 0) return cached.filter(notSelf);
    const fromSessions = (await this.store.loadSessions(recipientId)).map((s) => s.deviceId).filter(notSelf);
    if (fromSessions.length > 0) return fromSessions;
    try {
      return await this.fetchAndProcessBundles(recipientId, '*');
    } catch (err: any) {
      // Our own account has no other devices to sync to
      if (recipientId === auth.aci && err && err.status === 404) return [];
      throw err;
    }
  }

  private async ensureSession(recipientId: string, deviceId: number): Promise<void> {
    if (await hasUsableSession(this.store, recipientId, deviceId)) return;
    await this.fetchAndProcessBundles(recipientId, String(deviceId));
  }

  /**
   * Encrypt and deliver a Content to all devices of `recipientId` (an ACI) via `PUT /v1/messages/{recipientId}`, using Sealed Sender when we know the recipient's profile key, and handling 409 (missing/extra devices) and 410 (stale devices) by updating sessions and retrying.
   */
  async sendContentToRecipient(recipientId: string, content: Content, timestamp: number, online = false): Promise<void> {
    if (!isAci(recipientId)) throw new Error('Signal recipients are addressed by ACI; unknown service ID ' + recipientId);
    const auth = await this.authHeader();
    const local = await localIdentity(this.store);
    const plainBytes = padMessagePlaintext(toBinary(ContentSchema, content));

    const peerProfileKey = recipientId !== auth.aci ? this.getPeerProfileKey(recipientId) : undefined;
    let senderCert: Uint8Array | null = null;
    let accessKey: string | undefined;
    if (peerProfileKey) {
      senderCert = await this.getSenderCertificate();
      if (senderCert) accessKey = toBase64(libsignal.profileKeyDeriveAccessKey(peerProfileKey));
    }

    let devices = await this.devicesFor(recipientId);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (devices.length === 0) return;
      const messages = [];
      for (const devId of devices) {
        await this.ensureSession(recipientId, devId);
        if (senderCert && accessKey) {
          const sealed = await sealedEncryptForDevice(this.store, local, recipientId, devId, senderCert, plainBytes);
          messages.push({
            type: Envelope_Type.UNIDENTIFIED_SENDER,
            destinationDeviceId: devId,
            destinationRegistrationId: sealed.registrationId,
            content: toBase64(sealed.body),
          });
        } else {
          const enc = await encryptForDevice(this.store, local, recipientId, devId, plainBytes);
          messages.push({
            type: enc.envelopeType,
            destinationDeviceId: devId,
            destinationRegistrationId: enc.registrationId,
            content: toBase64(enc.body),
          });
        }
      }

      try {
        await this.httpJson(
          'PUT',
          `/v1/messages/${encodeURIComponent(recipientId)}`,
          { messages, timestamp, online, urgent: !online },
          accessKey
            ? { baseUrl: this.serverUrl, noAuth: true, headers: { 'Unidentified-Access-Key': accessKey }, timeout: 20000 }
            : { baseUrl: this.serverUrl, basicAuth: auth, timeout: 20000 }
        );
        this.deviceLists.set(recipientId, devices);
        return;
      } catch (err: any) {
        const status = err && err.status;
        const body = err && err.body;
        if (status === 409 && body) {
          const extra: number[] = Array.isArray(body.extraDevices) ? body.extraDevices : [];
          const missing: number[] = Array.isArray(body.missingDevices) ? body.missingDevices : [];
          for (const ex of extra) await deleteSession(this.store, recipientId, ex);
          devices = devices.filter((d) => !extra.includes(d)).concat(missing.filter((d) => !devices.includes(d)));
          this.deviceLists.set(recipientId, devices);
          continue;
        }
        if (status === 410 && body) {
          const stale: number[] = Array.isArray(body.staleDevices) ? body.staleDevices : [];
          for (const st of stale) await deleteSession(this.store, recipientId, st);
          continue;
        }
        if (status === 401 && accessKey) {
          // Wrong or outdated profile key: retry identified
          accessKey = undefined;
          senderCert = null;
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Send a group Content to every member as individual Sealed Sender (or identified) 1:1 messages. Signal's multi-recipient sender-key endpoint needs group send endorsements we don't hold, and a raw SenderKeyMessage via /v1/messages is not a valid envelope, so groups use pairwise fanout. Errors for single members are collected; the call fails only if no member received it.
   */
  async sendGroupContent(recipients: string[], content: Content, timestamp: number, online = false): Promise<void> {
    const auth = await this.authHeader();
    const targets = recipients.filter((p) => p && p !== auth.aci && isAci(p));
    let lastError: unknown = null;
    let delivered = 0;
    for (const peer of targets) {
      try {
        await this.sendContentToRecipient(peer, content, timestamp, online);
        delivered++;
      } catch (err) {
        lastError = err;
      }
    }
    if (targets.length > 0 && delivered === 0 && lastError) throw lastError;
  }

  /**
   * Send a SyncMessage to our own primary/linked devices so sent messages and read state stay in sync.
   */
  async sendSyncMessage(syncContent: Content, timestamp = Date.now()): Promise<void> {
    const auth = await this.authHeader();
    try {
      await this.sendContentToRecipient(auth.aci, syncContent, timestamp);
    } catch {
      // Best-effort sync to sibling linked devices
    }
  }

  /**
   * Request Contacts, Blocked, Configuration, and Keys (account entropy pool / master key) sync from the primary device.
   */
  async requestInitialSync(): Promise<void> {
    const types = [
      SyncMessage_Request_Type.CONTACTS,
      SyncMessage_Request_Type.BLOCKED,
      SyncMessage_Request_Type.CONFIGURATION,
      SyncMessage_Request_Type.KEYS,
    ];
    for (const type of types) {
      await this.sendSyncMessage(
        create(ContentSchema, { content: { case: 'syncMessage', value: { content: { case: 'request', value: { type } } } } })
      );
    }
  }

  /**
   * Download and decrypt an attachment from the Signal CDN named by its pointer, stripping Signal's size padding.
   */
  async downloadAttachment(descriptorIdOrPointer: string | AttachmentPointer): Promise<{ bytes: Uint8Array; contentType: string }> {
    let desc: AttachmentDescriptor | null;
    if (typeof descriptorIdOrPointer === 'string') {
      desc = decodeAttachmentDescriptor(descriptorIdOrPointer);
    } else {
      const p = descriptorIdOrPointer;
      desc = {
        cdnKey: attachmentCdnKey(p),
        cdnNumber: p.cdnNumber || 0,
        key: p.key,
        digest: p.digest.length ? p.digest : undefined,
        contentType: p.contentType || 'application/octet-stream',
        fileName: p.fileName,
        size: p.size,
      };
    }
    if (!desc || !desc.cdnKey) throw new Error('Invalid attachment descriptor');
    if (desc.key.length !== 64) throw new Error('Attachment pointer missing key');
    const cdnBase = SIGNAL_CDNS[desc.cdnNumber];
    if (!cdnBase) throw new Error('Unknown attachment CDN ' + desc.cdnNumber);

    const encryptedBytes = await this.httpBinary('GET', `${cdnBase}/attachments/${encodeURIComponent(desc.cdnKey)}`, null, {}, 60000);
    const decrypted = await decryptAttachment(encryptedBytes, desc.key, desc.digest);
    const bytes = desc.size > 0 && desc.size <= decrypted.length ? decrypted.subarray(0, desc.size) : decrypted;
    return { bytes, contentType: desc.contentType };
  }

  /**
   * Encrypt and upload an attachment like Signal-Desktop: pad, encrypt, fetch a `GET /v4/attachments/form/upload` form, then upload with TUS (CDN 3) or a resumable PUT (CDN 2).
   */
  async uploadAttachment(plaintext: Uint8Array, contentType: string, fileName: string): Promise<AttachmentPointer> {
    const auth = await this.authHeader();
    const encrypted = await encryptAttachment(plaintext);
    const size = encrypted.ciphertext.length;

    const form = await this.httpJson('GET', `/v4/attachments/form/upload?uploadLength=${size}`, null, {
      baseUrl: this.serverUrl,
      basicAuth: auth,
      timeout: 15000,
    });
    if (!form || typeof form.key !== 'string' || typeof form.signedUploadLocation !== 'string' || typeof form.cdn !== 'number') {
      throw new Error('Signal server returned an invalid attachment upload form');
    }
    const formHeaders: Record<string, string> = {};
    if (form.headers && typeof form.headers === 'object') {
      for (const k of Object.keys(form.headers)) {
        if (typeof form.headers[k] === 'string') formHeaders[k] = form.headers[k];
      }
    }

    if (form.cdn === 3) {
      await this.httpBinary(
        'POST',
        form.signedUploadLocation,
        encrypted.ciphertext,
        {
          ...formHeaders,
          'Tus-Resumable': '1.0.0',
          'Upload-Length': String(size),
          'Upload-Metadata': 'filename ' + toBase64(new TextEncoder().encode(form.key)),
          'Content-Type': 'application/offset+octet-stream',
        },
        120000
      );
    } else {
      if (!this.httpRaw) throw new Error('CDN ' + form.cdn + ' uploads need a raw HTTP transport');
      const start = await this.httpRaw('POST', form.signedUploadLocation, null, formHeaders, 30000);
      if (!start.location) throw new Error('Attachment upload form returned no upload location');
      await this.httpBinary('PUT', start.location, encrypted.ciphertext, { 'Content-Range': `bytes 0-*/${size}` }, 120000);
    }

    return create(AttachmentPointerSchema, {
      attachmentIdentifier: { case: 'cdnKey', value: form.key },
      cdnNumber: form.cdn,
      contentType,
      key: encrypted.key,
      size: plaintext.length,
      digest: encrypted.digest,
      fileName,
      uploadTimestamp: BigInt(Date.now()),
    });
  }

  /**
   * Compute safety numbers for all known remote ACI identities, matching `App.api.identities()` shape.
   */
  async listIdentitiesWithSafetyNumbers(): Promise<
    Array<{
      uuid?: string;
      number?: string;
      safety_number: string;
      scannable_safety_number: string;
      trust_level: TrustLevel;
      added_timestamp: number;
    }>
  > {
    const acc = await this.store.getAccount();
    if (!acc) return [];
    const all = await this.store.getAllIdentities();
    const out = [];
    for (const id of all) {
      const aci = id.uuid || id.address;
      if (aci === acc.aci || !isAci(aci)) continue;
      const sn = safetyNumber(acc.aci, acc.aciIdentityKeyPair.pubKey, aci, id.publicKey);
      out.push({
        uuid: aci,
        number: id.number,
        safety_number: sn.safetyNumber,
        scannable_safety_number: toBase64(sn.scannable),
        trust_level: id.trustLevel,
        added_timestamp: id.addedTimestamp,
      });
    }
    return out;
  }
}
