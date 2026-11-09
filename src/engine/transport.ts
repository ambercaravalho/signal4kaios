/* On-Device Signal Transport, Envelope Decryption Pipeline, and Outbound Fanout.
 *
 * Bridges raw Signal Protocol wire messages (Envelope + Content protobufs)
 * to the JSON envelope structure consumed by App.normalize and App.store.
 */

import { fromBase64, toBase64 } from './bytes';
import {
  decryptAttachment,
  encryptAttachment,
} from './crypto/attachment';
import {
  padMessagePlaintext,
  unpadMessagePlaintext,
  hashSha256,
} from './crypto/primitives';
import {
  AttachmentPointer,
  BodyRangeProto,
  BodyRangeStyle,
  ContentProto,
  DataMessage,
  decodeContactDetails,
  decodeContent,
  decodeEnvelope,
  decodeGroupDetails,
  decodePlaintextContentProto,
  decodeSenderCertificate,
  encodeContent,
  encodePlaintextContentProto,
  Envelope,
  EnvelopeType,
  ProtoReader,
  ReceiptType,
  SenderCertificate,
  SyncRequestType,
  TypingAction,
} from './proto';
import { generateSafetyNumber } from './protocol/fingerprint';
import {
  deriveUnidentifiedAccessKey,
  sealSenderMessage,
  unsealSenderMessage,
} from './protocol/sealed-sender';
import {
  decryptSenderKeyMessage,
  createSenderKeyDistributionMessage,
  encryptSenderKeyMessage,
  processSenderKeyDistributionMessage,
} from './protocol/sender-keys';
import {
  deriveGroupV2Keys,
} from './groups-v2';
import {
  decryptPreKeyWhisperMessage,
  decryptWhisperMessage,
  encryptWhisperMessage,
  initSessionFromPreKeyBundle,
  RemotePreKeyBundle,
} from './protocol/session';
import type { SignalHttpJsonFn } from './provisioning';
import type { SignalProtocolStore, TrustLevel } from './storage';

export const DEFAULT_SIGNAL_SERVER = 'https://chat.signal.org';
export const DEFAULT_SIGNAL_CDN = 'https://cdn.signal.org';
export const DEFAULT_SIGNAL_CDN2 = 'https://cdn2.signal.org';

export type SignalHttpBinaryFn = (
  method: string,
  url: string,
  body?: Uint8Array | null,
  headers?: Record<string, string>,
  timeout?: number
) => Promise<Uint8Array>;

function deriveGroupInternalId(groupBytes: Uint8Array): string {
  // Match deterministic base64 group ID
  return toBase64(groupBytes);
}

function groupV2IdFromMasterKey(masterKey: Uint8Array): string {
  if (masterKey.length === 32) {
    return deriveGroupV2Keys(masterKey).internalId;
  }
  const derived = hashSha256(masterKey);
  return toBase64(derived);
}

function encodeAttachmentDescriptor(att: AttachmentPointer): string {
  const meta = {
    cdnKey: att.cdnKey || (att.cdnId !== undefined ? att.cdnId.toString() : ''),
    cdnNumber: att.cdnNumber || 0,
    key: att.key ? toBase64(att.key) : '',
    digest: att.digest ? toBase64(att.digest) : '',
    contentType: att.contentType || 'application/octet-stream',
    fileName: att.fileName || '',
    size: att.size || 0,
  };
  return 's4katt:' + toBase64(new TextEncoder().encode(JSON.stringify(meta)));
}

export function decodeAttachmentDescriptor(id: string): {
  cdnKey: string;
  cdnNumber: number;
  key: Uint8Array;
  digest?: Uint8Array;
  contentType: string;
  fileName: string;
  size: number;
} | null {
  if (!id || !id.startsWith('s4katt:')) return null;
  try {
    const json = new TextDecoder().decode(fromBase64(id.slice(7)));
    const parsed = JSON.parse(json);
    return {
      cdnKey: parsed.cdnKey || '',
      cdnNumber: parsed.cdnNumber || 0,
      key: fromBase64(parsed.key || ''),
      digest: parsed.digest ? fromBase64(parsed.digest) : undefined,
      contentType: parsed.contentType || 'application/octet-stream',
      fileName: parsed.fileName || '',
      size: parsed.size || 0,
    };
  } catch {
    return null;
  }
}

function styleName(style?: BodyRangeStyle): string | null {
  switch (style) {
    case BodyRangeStyle.BOLD: return 'BOLD';
    case BodyRangeStyle.ITALIC: return 'ITALIC';
    case BodyRangeStyle.SPOILER: return 'SPOILER';
    case BodyRangeStyle.STRIKETHROUGH: return 'STRIKETHROUGH';
    case BodyRangeStyle.MONOSPACE: return 'MONOSPACE';
    default: return null;
  }
}

function convertDataMessageToNormalizeJson(dm: DataMessage, fallbackTs?: number): any {
  const mentions: Array<{ start: number; length: number; uuid: string }> = [];
  const textStyles: Array<{ start: number; length: number; style: string }> = [];

  for (const br of dm.bodyRanges || []) {
    const start = br.start || 0;
    const length = br.length || 1;
    if (br.mentionUuid) {
      mentions.push({ start, length, uuid: br.mentionUuid });
    } else {
      const st = styleName(br.style);
      if (st) textStyles.push({ start, length, style: st });
    }
  }

  let groupInfo: { groupId: string } | undefined;
  if (dm.groupV2 && dm.groupV2.masterKey) {
    groupInfo = { groupId: groupV2IdFromMasterKey(dm.groupV2.masterKey) };
  } else if (dm.groupV1 && dm.groupV1.id) {
    groupInfo = { groupId: deriveGroupInternalId(dm.groupV1.id) };
  }

  const rawAttachments = [...(dm.attachments || [])];
  if (dm.sticker && dm.sticker.data) {
    const stData = dm.sticker.data;
    rawAttachments.push({
      ...stData,
      contentType: stData.contentType || 'image/webp',
      fileName: stData.fileName || 'sticker.webp',
    });
  }

  const out: any = {
    timestamp: dm.timestamp || fallbackTs || Date.now(),
    message: dm.body ?? (dm.sticker && dm.sticker.emoji ? dm.sticker.emoji : null),
    expiresInSeconds: dm.expireTimer || 0,
    viewOnce: !!dm.isViewOnce,
    mentions,
    textStyles,
    groupInfo,
    attachments: rawAttachments.map((a) => ({
      id: encodeAttachmentDescriptor(a),
      contentType: a.contentType || 'application/octet-stream',
      filename: a.fileName || '',
      size: a.size || 0,
      voiceNote: ((a.flags || 0) & 0x01) !== 0,
      viewOnce: !!dm.isViewOnce,
    })),
  };

  if (dm.quote) {
    out.quote = {
      id: dm.quote.id || 0,
      authorNumber: dm.quote.authorE164 || undefined,
      authorUuid: dm.quote.authorUuid || undefined,
      text: dm.quote.text || '',
    };
  }

  if (dm.reaction) {
    out.reaction = {
      emoji: dm.reaction.emoji || '',
      isRemove: !!dm.reaction.remove,
      targetAuthorNumber: dm.reaction.targetAuthorE164 || undefined,
      targetAuthorUuid: dm.reaction.targetAuthorUuid || undefined,
      targetSentTimestamp: dm.reaction.targetSentTimestamp || 0,
    };
  }

  if (dm.delete) {
    out.remoteDelete = {
      timestamp: dm.delete.targetSentTimestamp || 0,
    };
  }

  return out;
}

/**
 * Convert a decrypted Signal ContentProto + Envelope metadata into the JSON frame
 * format consumed by `App.normalize.parse`.
 */
export function contentToNormalizedFrame(
  env: Envelope,
  content: ContentProto
): { envelope: any } {
  const frameEnv: any = {
    source: env.sourceE164 || env.sourceUuid || '',
    sourceNumber: env.sourceE164 || undefined,
    sourceUuid: env.sourceUuid || undefined,
    sourceDevice: env.sourceDevice || 1,
    timestamp: env.timestamp || Date.now(),
  };

  if (content.dataMessage) {
    frameEnv.dataMessage = convertDataMessageToNormalizeJson(
      content.dataMessage,
      env.timestamp
    );
  }

  if (content.callMessage && content.callMessage.offer) {
    const isVideo = content.callMessage.offer.type === 1;
    frameEnv.dataMessage = {
      timestamp: env.timestamp || Date.now(),
      message: isVideo ? '📹 Missed video call' : '📞 Missed voice call',
      expiresInSeconds: 0,
      mentions: [],
      textStyles: [],
      attachments: [],
    };
  }

  if (content.editMessage) {
    frameEnv.editMessage = {
      targetSentTimestamp: content.editMessage.targetSentTimestamp || 0,
      dataMessage: content.editMessage.dataMessage
        ? convertDataMessageToNormalizeJson(
            content.editMessage.dataMessage,
            env.timestamp
          )
        : {},
    };
  }

  if (content.typingMessage) {
    const tm = content.typingMessage;
    frameEnv.typingMessage = {
      timestamp: tm.timestamp || env.timestamp || Date.now(),
      action: tm.action === TypingAction.STOPPED ? 'STOPPED' : 'STARTED',
      groupId: tm.groupId ? deriveGroupInternalId(tm.groupId) : undefined,
    };
  }

  if (content.receiptMessage) {
    const rm = content.receiptMessage;
    frameEnv.receiptMessage = {
      when: env.timestamp || Date.now(),
      isDelivery: rm.type === ReceiptType.DELIVERY,
      isRead: rm.type === ReceiptType.READ,
      isViewed: rm.type === ReceiptType.VIEWED,
      timestamps: rm.timestamp || [],
    };
  }

  if (content.syncMessage) {
    const sm = content.syncMessage;
    const syncOut: any = {};
    if (sm.sent) {
      const s = sm.sent;
      if (s.editMessage) {
        const innerDm = s.editMessage.dataMessage
          ? convertDataMessageToNormalizeJson(s.editMessage.dataMessage, s.timestamp)
          : {};
        syncOut.sentMessage = {
          destination: s.destinationE164 || s.destinationUuid || '',
          destinationNumber: s.destinationE164 || undefined,
          destinationUuid: s.destinationUuid || undefined,
          timestamp: s.timestamp || env.timestamp || Date.now(),
          groupInfo: innerDm.groupInfo,
          editMessage: {
            targetSentTimestamp: s.editMessage.targetSentTimestamp || 0,
            dataMessage: innerDm,
          },
        };
      } else if (s.message) {
        const innerDm = convertDataMessageToNormalizeJson(s.message, s.timestamp);
        syncOut.sentMessage = {
          ...innerDm,
          destination: s.destinationE164 || s.destinationUuid || '',
          destinationNumber: s.destinationE164 || undefined,
          destinationUuid: s.destinationUuid || undefined,
          timestamp: s.timestamp || innerDm.timestamp || Date.now(),
        };
      }
    }
    if (sm.read && sm.read.length > 0) {
      syncOut.readMessages = sm.read.map((r) => ({
        sender: r.senderE164 || r.senderUuid || '',
        senderNumber: r.senderE164 || undefined,
        senderUuid: r.senderUuid || undefined,
        timestamp: r.timestamp || 0,
      }));
    }
    frameEnv.syncMessage = syncOut;
  }

  return { envelope: frameEnv };
}

/**
 * Decrypt a binary Signal `Envelope` protobuf into a `ContentProto` and normalized JSON frame.
 */
export async function decryptEnvelope(
  store: SignalProtocolStore,
  envelopeBytes: Uint8Array
): Promise<{
  envelope: Envelope;
  content: ContentProto;
  normalizedFrame: { envelope: any };
} | null> {
  const env = decodeEnvelope(envelopeBytes);
  const payload = env.content || env.legacyMessage;

  // Server delivery receipts have no encrypted body
  if (env.type === EnvelopeType.RECEIPT && !payload) {
    const content: ContentProto = {
      receiptMessage: {
        type: ReceiptType.DELIVERY,
        timestamp: env.timestamp ? [env.timestamp] : [],
      },
    };
    return {
      envelope: env,
      content,
      normalizedFrame: contentToNormalizedFrame(env, content),
    };
  }

  if (!payload || payload.length === 0) {
    return null;
  }

  let paddedPlaintext: Uint8Array;

  if (env.type === EnvelopeType.UNIDENTIFIED_SENDER) {
    const unsealed = await unsealSenderMessage(store, payload);
    env.sourceUuid = unsealed.senderUuid || env.sourceUuid;
    env.sourceE164 = unsealed.senderE164 || env.sourceE164;
    env.sourceDevice = unsealed.senderDevice;
    paddedPlaintext = unsealed.plaintext;
  } else {
    const senderId = env.sourceUuid || env.sourceE164;
    if (!senderId) {
      throw new Error('Identified envelope missing sourceUuid and sourceE164');
    }
    const senderDevice = env.sourceDevice || 1;
    const senderAddress = `${senderId}.${senderDevice}`;

    if (env.type === EnvelopeType.PREKEY_BUNDLE) {
      paddedPlaintext = await decryptPreKeyWhisperMessage(store, senderAddress, payload);
    } else if (env.type === EnvelopeType.CIPHERTEXT) {
      paddedPlaintext = await decryptWhisperMessage(store, senderAddress, payload);
    } else if (env.type === EnvelopeType.SENDERKEY_MESSAGE) {
      paddedPlaintext = await decryptSenderKeyMessage(store, senderAddress, payload);
    } else if (env.type === EnvelopeType.PLAINTEXT_CONTENT) {
      paddedPlaintext = payload;
    } else {
      throw new Error(`Unsupported EnvelopeType ${env.type}`);
    }
  }

  const unpadded = unpadMessagePlaintext(paddedPlaintext);
  const content = decodeContent(unpadded);

  // Handle DataMessage.Flags.END_SESSION (0x01) by resetting the sender's Double Ratchet session
  if (content.dataMessage && ((content.dataMessage.flags || 0) & 0x01) !== 0) {
    const senderId = env.sourceUuid || env.sourceE164;
    if (senderId) {
      await store.deleteSession(`${senderId}.${env.sourceDevice || 1}`);
    }
  }

  // If the message includes a SenderKeyDistributionMessage, process it so future group messages decrypt
  if (content.senderKeyDistributionMessage) {
    const senderId = env.sourceUuid || env.sourceE164;
    if (senderId) {
      const senderAddress = `${senderId}.${env.sourceDevice || 1}`;
      await processSenderKeyDistributionMessage(
        store,
        senderAddress,
        content.senderKeyDistributionMessage
      );
    }
  }

  return {
    envelope: env,
    content,
    normalizedFrame: contentToNormalizedFrame(env, content),
  };
}

/**
 * Parse a length-delimited ContactDetails sync blob from primary device.
 */
export function parseContactsSyncBlob(blobBytes: Uint8Array): Array<{
  uuid: string;
  number: string;
  name: string;
  blocked: boolean;
  expireTimer: number;
  profileKey?: string;
}> {
  const r = new ProtoReader(blobBytes);
  const contacts: Array<{
    uuid: string;
    number: string;
    name: string;
    blocked: boolean;
    expireTimer: number;
    profileKey?: string;
  }> = [];

  while (!r.eof()) {
    const msgLen = r.readUint32();
    if (msgLen === 0 || r.pos + msgLen > r.len) break;
    const msgBytes = r.buf.slice(r.pos, r.pos + msgLen);
    r.pos += msgLen;
    const c = decodeContactDetails(msgBytes);
    // Skip embedded avatar bytes if present
    if (c.avatar && c.avatar.length && r.pos + c.avatar.length <= r.len) {
      r.pos += c.avatar.length;
    }
    if (c.uuid || c.number) {
      contacts.push({
        uuid: c.uuid || '',
        number: c.number || '',
        name: c.name || c.number || c.uuid || '',
        blocked: !!c.blocked,
        expireTimer: c.expireTimer || 0,
        profileKey: c.profileKey ? toBase64(c.profileKey) : undefined,
      });
    }
  }

  return contacts;
}

/**
 * Parse a length-delimited GroupDetails sync blob from primary device.
 */
export function parseGroupsSyncBlob(blobBytes: Uint8Array): Array<{
  id: string;
  internal_id: string;
  name: string;
  members: string[];
  blocked: boolean;
  expireTimer: number;
}> {
  const r = new ProtoReader(blobBytes);
  const groups: Array<{
    id: string;
    internal_id: string;
    name: string;
    members: string[];
    blocked: boolean;
    expireTimer: number;
  }> = [];

  while (!r.eof()) {
    const msgLen = r.readUint32();
    if (msgLen === 0 || r.pos + msgLen > r.len) break;
    const msgBytes = r.buf.slice(r.pos, r.pos + msgLen);
    r.pos += msgLen;
    const g = decodeGroupDetails(msgBytes);
    if (g.avatar && g.avatar.length && r.pos + g.avatar.length <= r.len) {
      r.pos += g.avatar.length;
    }
    if (g.id) {
      const b64 = deriveGroupInternalId(g.id);
      groups.push({
        id: 'group.' + b64,
        internal_id: b64,
        name: g.name || 'Group',
        members: g.membersE164 || [],
        blocked: !!g.blocked,
        expireTimer: g.expireTimer || 0,
      });
    }
  }

  return groups;
}

function parseServerPreKeyResponse(
  recipientId: string,
  json: any
): RemotePreKeyBundle[] {
  if (!json || !Array.isArray(json.devices)) return [];
  const identityKey = fromBase64(json.identityKey);
  return json.devices
    .filter((d: any) => d && d.signedPreKey)
    .map((d: any) => {
      const pq = d.pqPreKey || d.kyberPreKey || d.pqLastResortPreKey;
      return {
        registrationId: d.registrationId || 0,
        deviceId: d.deviceId || 1,
        preKeyId: d.preKey ? d.preKey.keyId : undefined,
        preKeyPublic: d.preKey ? fromBase64(d.preKey.publicKey) : undefined,
        signedPreKeyId: d.signedPreKey.keyId,
        signedPreKeyPublic: fromBase64(d.signedPreKey.publicKey),
        signedPreKeySignature: fromBase64(d.signedPreKey.signature),
        kyberPreKeyId: pq ? pq.keyId : undefined,
        kyberPreKeyPublic: pq ? fromBase64(pq.publicKey) : undefined,
        kyberPreKeySignature: pq ? fromBase64(pq.signature) : undefined,
        identityKey,
      };
    });
}

/**
 * High-level SignalClient coordinating outbound encryption, device fanout,
 * attachment upload/download, and identity verification.
 */
export class SignalClient {
  private deviceLists = new Map<string, number[]>();
  private profileKeys = new Map<string, Uint8Array>();
  private distributedSenderKeys = new Set<string>();
  private cachedSenderCert: { cert: SenderCertificate; expiresAt: number } | null = null;
  private decryptQueue: Promise<any> = Promise.resolve();

  constructor(
    public readonly store: SignalProtocolStore,
    private readonly httpJson: SignalHttpJsonFn,
    private readonly httpBinary: SignalHttpBinaryFn,
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

  private async getSenderCertificate(): Promise<SenderCertificate | null> {
    if (this.cachedSenderCert && this.cachedSenderCert.expiresAt > Date.now()) {
      return this.cachedSenderCert.cert;
    }
    try {
      const auth = await this.authHeader();
      const res = await this.httpJson(
        'GET',
        '/v1/certificate/delivery?includeE164=true',
        null,
        {
          baseUrl: this.serverUrl,
          basicAuth: auth,
          timeout: 10000,
        }
      );
      if (res && res.certificate) {
        const cert = decodeSenderCertificate(fromBase64(res.certificate));
        this.cachedSenderCert = {
          cert,
          expiresAt: Date.now() + 12 * 3600 * 1000,
        };
        return cert;
      }
    } catch {
      // Fallback to identified delivery if certificate fetch fails
    }
    return null;
  }

  /**
   * Send a PlaintextContent DecryptionErrorMessage retry receipt to a sender device
   * whose message failed to decrypt, prompting it to re-initialize the ratchet.
   */
  async sendDecryptionErrorReceipt(failedEnv: Envelope): Promise<void> {
    const senderId = failedEnv.sourceUuid || failedEnv.sourceE164;
    if (!senderId) return;
    const senderDevice = failedEnv.sourceDevice || 1;
    try {
      const auth = await this.authHeader();
      await this.store.deleteSession(`${senderId}.${senderDevice}`);
      const ptBytes = encodePlaintextContentProto({
        decryptionErrorMessage: {
          timestamp: failedEnv.timestamp || Date.now(),
          deviceId: auth.deviceId,
        },
      });
      await this.httpJson(
        'PUT',
        `/v1/messages/${encodeURIComponent(senderId)}`,
        {
          messages: [
            {
              type: EnvelopeType.PLAINTEXT_CONTENT,
              destinationDeviceId: senderDevice,
              content: toBase64(ptBytes),
            },
          ],
          timestamp: Date.now(),
          online: false,
        },
        {
          baseUrl: this.serverUrl,
          basicAuth: auth,
          timeout: 10000,
        }
      );
    } catch {
      // Best-effort retry receipt
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
   * Enqueue an incoming binary Envelope for strictly serialized session decryption.
   * Automatically sends a DecryptionErrorMessage retry receipt if a ciphertext envelope fails to decrypt.
   */
  enqueueDecryptEnvelope(envelopeBytes: Uint8Array): Promise<{
    envelope: Envelope;
    content: ContentProto;
    normalizedFrame: { envelope: any };
  } | null> {
    const next = this.decryptQueue.then(async () => {
      try {
        const res = await decryptEnvelope(this.store, envelopeBytes);
        if (res && res.content.dataMessage && res.content.dataMessage.profileKey) {
          const senderId = res.envelope.sourceUuid || res.envelope.sourceE164;
          if (senderId) {
            this.setPeerProfileKey(senderId, res.content.dataMessage.profileKey);
          }
        }
        return res;
      } catch (err) {
        try {
          const parsedEnv = decodeEnvelope(envelopeBytes);
          await this.sendDecryptionErrorReceipt(parsedEnv);
        } catch {
          // ignore malformed outer envelope
        }
        throw err;
      }
    });
    this.decryptQueue = next.catch(() => null);
    return next;
  }

  /**
   * Ensure we have active Double Ratchet sessions for all devices of `recipientId`.
   */
  private async ensureSessionsForRecipient(
    recipientId: string,
    deviceIds: number[]
  ): Promise<number[]> {
    const auth = await this.authHeader();
    const missing: number[] = [];

    for (const devId of deviceIds) {
      if (recipientId === auth.aci && devId === auth.deviceId) continue;
      const existing = await this.store.loadSession(`${recipientId}.${devId}`);
      if (!existing) missing.push(devId);
    }

    if (missing.length > 0) {
      const selector = missing.length === 1 ? String(missing[0]) : '*';
      const res = await this.httpJson(
        'GET',
        `/v2/keys/${encodeURIComponent(recipientId)}/${selector}`,
        null,
        {
          baseUrl: this.serverUrl,
          basicAuth: auth,
          timeout: 15000,
        }
      );
      const bundles = parseServerPreKeyResponse(recipientId, res);
      const activeDevs: number[] = [];
      for (const b of bundles) {
        if (recipientId === auth.aci && b.deviceId === auth.deviceId) continue;
        await initSessionFromPreKeyBundle(
          this.store,
          `${recipientId}.${b.deviceId}`,
          b
        );
        activeDevs.push(b.deviceId);
      }
      if (activeDevs.length > 0 && selector === '*') {
        this.deviceLists.set(recipientId, activeDevs);
        return activeDevs;
      }
    }

    return deviceIds.filter((d) => !(recipientId === auth.aci && d === auth.deviceId));
  }

  /**
   * Encrypt and deliver a `ContentProto` to all devices of `recipientId` via `PUT /v1/messages/{recipientId}`,
   * automatically handling 409 (missing/extra devices) and 410 (stale devices) retries.
   */
  async sendContentToRecipient(
    recipientId: string,
    content: ContentProto,
    timestamp: number,
    online = false
  ): Promise<void> {
    const auth = await this.authHeader();
    const plainBytes = padMessagePlaintext(encodeContent(content));

    let knownDevices = this.deviceLists.get(recipientId);
    if (!knownDevices || knownDevices.length === 0) {
      knownDevices = recipientId === auth.aci ? [1] : [1];
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const targetDevices = await this.ensureSessionsForRecipient(recipientId, knownDevices);
      if (targetDevices.length === 0) return;

      const peerProfileKey =
        recipientId !== auth.aci ? this.getPeerProfileKey(recipientId) : undefined;
      let senderCert: SenderCertificate | null = null;
      let unidentifiedAccessHeader: string | undefined;

      if (peerProfileKey) {
        senderCert = await this.getSenderCertificate();
        if (senderCert) {
          const uak = await deriveUnidentifiedAccessKey(peerProfileKey);
          unidentifiedAccessHeader = toBase64(uak);
        }
      }

      const messages = [];
      for (const devId of targetDevices) {
        const addr = `${recipientId}.${devId}`;
        if (senderCert && unidentifiedAccessHeader) {
          const session = await this.store.loadSession(addr);
          const sealed = await sealSenderMessage(
            this.store,
            addr,
            senderCert,
            plainBytes
          );
          messages.push({
            type: EnvelopeType.UNIDENTIFIED_SENDER,
            destinationDeviceId: devId,
            destinationRegistrationId: session ? session.remoteRegistrationId : 0,
            content: toBase64(sealed),
          });
        } else {
          const enc = await encryptWhisperMessage(this.store, addr, plainBytes);
          messages.push({
            type: enc.type,
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
          {
            messages,
            timestamp,
            online,
          },
          unidentifiedAccessHeader
            ? {
                baseUrl: this.serverUrl,
                noAuth: true,
                headers: { 'Unidentified-Access-Key': unidentifiedAccessHeader },
                timeout: 20000,
              }
            : {
                baseUrl: this.serverUrl,
                basicAuth: auth,
                timeout: 20000,
              }
        );
        this.deviceLists.set(recipientId, targetDevices);
        return;
      } catch (err: any) {
        const status = err && err.status;
        const body = err && err.body;
        if (status === 409 && body) {
          const extra: number[] = body.extraDevices || [];
          const missing: number[] = body.missingDevices || [];
          for (const ex of extra) {
            await this.store.deleteSession(`${recipientId}.${ex}`);
          }
          knownDevices = targetDevices
            .filter((d) => !extra.includes(d))
            .concat(missing);
          this.deviceLists.set(recipientId, knownDevices);
          continue;
        }
        if (status === 410 && body) {
          const stale: number[] = body.staleDevices || [];
          for (const st of stale) {
            await this.store.deleteSession(`${recipientId}.${st}`);
          }
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Send a group ContentProto to `recipients`:
   * 1. Distributes our `SenderKeyDistributionMessage` via pairwise 1:1 sessions to any member
   *    who has not yet received our current SenderKey for `groupInternalId`.
   * 2. Encrypts the group message with our `SenderKey` (`encryptSenderKeyMessage`) and delivers
   *    to each member, falling back to pairwise encryption if a member requires re-keying.
   */
  async sendGroupContentWithSenderKeys(
    groupInternalId: string,
    recipients: string[],
    content: ContentProto,
    timestamp: number,
    online = false
  ): Promise<void> {
    const auth = await this.authHeader();
    const senderKeyName = `${groupInternalId}::${auth.aci}.${auth.deviceId}`;
    const skdmBytes = await createSenderKeyDistributionMessage(
      this.store,
      senderKeyName
    );

    for (const peer of recipients) {
      if (!peer || peer === auth.aci || peer === auth.number) continue;
      const distKey = `${groupInternalId}::${peer}`;
      if (!this.distributedSenderKeys.has(distKey)) {
        try {
          await this.sendContentToRecipient(
            peer,
            { senderKeyDistributionMessage: skdmBytes },
            timestamp,
            online
          );
          this.distributedSenderKeys.add(distKey);
        } catch {
          // Will fall back to pairwise below
        }
      }
    }

    const plainBytes = padMessagePlaintext(encodeContent(content));
    const skmBytes = await encryptSenderKeyMessage(
      this.store,
      senderKeyName,
      plainBytes
    );

    for (const peer of recipients) {
      if (!peer || peer === auth.aci || peer === auth.number) continue;
      const distKey = `${groupInternalId}::${peer}`;
      if (this.distributedSenderKeys.has(distKey)) {
        try {
          const devices = this.deviceLists.get(peer) || [1];
          const messages = devices.map((devId) => ({
            type: EnvelopeType.SENDERKEY_MESSAGE,
            destinationDeviceId: devId,
            content: toBase64(skmBytes),
          }));
          await this.httpJson(
            'PUT',
            `/v1/messages/${encodeURIComponent(peer)}`,
            { messages, timestamp, online },
            { baseUrl: this.serverUrl, basicAuth: auth, timeout: 20000 }
          );
          continue;
        } catch {
          this.distributedSenderKeys.delete(distKey);
        }
      }
      // Fallback to pairwise Double Ratchet fanout
      await this.sendContentToRecipient(peer, content, timestamp, online);
    }
  }

  /**
   * Send a SyncMessage to our own primary/linked devices so sent messages and read state stay in sync.
   */
  async sendSyncMessage(syncContent: ContentProto, timestamp = Date.now()): Promise<void> {
    const auth = await this.authHeader();
    try {
      await this.sendContentToRecipient(auth.aci, syncContent, timestamp);
    } catch {
      // Best-effort sync to sibling linked devices
    }
  }

  /**
   * Request full Contacts, Groups, Blocked, and Configuration sync from primary device.
   */
  async requestInitialSync(): Promise<void> {
    const types = [
      SyncRequestType.CONTACTS,
      SyncRequestType.GROUPS,
      SyncRequestType.BLOCKED,
      SyncRequestType.CONFIGURATION,
    ];
    for (const type of types) {
      await this.sendSyncMessage({
        syncMessage: {
          request: { type },
        },
      });
    }
  }

  /**
   * Download and decrypt an attachment from Signal CDN using its descriptor ID or AttachmentPointer.
   */
  async downloadAttachment(descriptorIdOrPointer: string | AttachmentPointer): Promise<{
    bytes: Uint8Array;
    contentType: string;
  }> {
    let cdnKey = '';
    let cdnNumber = 0;
    let key: Uint8Array;
    let digest: Uint8Array | undefined;
    let contentType = 'application/octet-stream';

    if (typeof descriptorIdOrPointer === 'string') {
      const desc = decodeAttachmentDescriptor(descriptorIdOrPointer);
      if (!desc) throw new Error('Invalid attachment descriptor');
      cdnKey = desc.cdnKey;
      cdnNumber = desc.cdnNumber;
      key = desc.key;
      digest = desc.digest;
      contentType = desc.contentType;
    } else {
      cdnKey =
        descriptorIdOrPointer.cdnKey ||
        (descriptorIdOrPointer.cdnId !== undefined
          ? descriptorIdOrPointer.cdnId.toString()
          : '');
      cdnNumber = descriptorIdOrPointer.cdnNumber || 0;
      if (!descriptorIdOrPointer.key) throw new Error('AttachmentPointer missing key');
      key = descriptorIdOrPointer.key;
      digest = descriptorIdOrPointer.digest;
      contentType = descriptorIdOrPointer.contentType || contentType;
    }

    const cdnBase = cdnNumber === 2 ? DEFAULT_SIGNAL_CDN2 : DEFAULT_SIGNAL_CDN;
    const path = cdnNumber === 2 ? `/attachments/${encodeURIComponent(cdnKey)}` : `/attachments/${encodeURIComponent(cdnKey)}`;
    const encryptedBytes = await this.httpBinary('GET', `${cdnBase}${path}`, null, {}, 60000);
    const decrypted = await decryptAttachment(encryptedBytes, key, digest);
    return { bytes: decrypted, contentType };
  }

  /**
   * Encrypt and upload an attachment to Signal CDN (`GET /v2/attachments/form/upload`).
   */
  async uploadAttachment(
    plaintext: Uint8Array,
    contentType: string,
    fileName: string
  ): Promise<AttachmentPointer> {
    const auth = await this.authHeader();
    const encrypted = await encryptAttachment(plaintext);

    const form = await this.httpJson('GET', '/v2/attachments/form/upload', null, {
      baseUrl: this.serverUrl,
      basicAuth: auth,
      timeout: 15000,
    });

    const cdnKey = (form && form.key) || String(Date.now());
    const cdnNumber = (form && form.cdn) || 2;
    const uploadUrl =
      (form && form.signedUploadLocation) ||
      `${DEFAULT_SIGNAL_CDN2}/attachments/${encodeURIComponent(cdnKey)}`;

    await this.httpBinary(
      'PUT',
      uploadUrl,
      encrypted.ciphertext,
      { 'Content-Type': 'application/octet-stream' },
      60000
    );

    return {
      cdnKey,
      cdnNumber,
      contentType,
      key: encrypted.key,
      size: encrypted.plaintextLength,
      digest: encrypted.digest,
      fileName,
      uploadTimestamp: Date.now(),
    };
  }

  /**
   * Compute safety numbers for all known remote identities, matching `App.api.identities()` shape.
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
    return all
      .filter((id) => id.address !== acc.aci && id.address !== acc.number)
      .map((id) => {
        const localId = id.uuid ? acc.aci : acc.number || acc.aci;
        const remoteId = id.uuid || id.number || id.address;
        const sn = generateSafetyNumber(
          localId,
          acc.aciIdentityKeyPair.pubKey,
          remoteId,
          id.publicKey
        );
        return {
          uuid: id.uuid,
          number: id.number,
          safety_number: sn.safetyNumber,
          scannable_safety_number: toBase64(sn.scannableQrBytes),
          trust_level: id.trustLevel,
          added_timestamp: id.addedTimestamp,
        };
      });
  }
}
