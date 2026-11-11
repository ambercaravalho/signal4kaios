/* Incoming envelope decryption: Envelope protobufs in, decrypted Content and the app's JSON frame (`./incoming-json`) out. */

import { bytesToUuid } from '../bytes';
import { unpadMessagePlaintext } from '../crypto/primitives';
import { ContactDetailsSchema, type Content, ContentSchema, DataMessage_Flags, Envelope_Type, EnvelopeSchema, ReceiptMessage_Type } from '../gen/SignalService_pb';
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
import { isUuid } from '../validate';
import { contentToNormalizedFrame } from './incoming-json';
import { create, fromBinary, num, readDelimited, serviceIdFrom } from './proto';

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
  reportSpamToken?: Uint8Array;
  /** Our new PNI, untagged, on the envelope carrying a number change. */
  updatedPni?: string;
}

/** Signal-Desktop `fromPniUuidBytesOrUntaggedString`: 16 raw bytes, or a UUID string with or without the `PNI:` tag. */
export function updatedPniFrom(str: string | undefined, binary: Uint8Array | undefined): string | undefined {
  const id = binary && binary.length === 16 ? bytesToUuid(binary) : (str || '').replace(/^PNI:/, '');
  return isUuid(id) ? id.toLowerCase() : undefined;
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
): Promise<{ plaintext: Uint8Array; identityChanged: boolean }> {
  try {
    if (type === CIPHERTEXT_PREKEY) return await decryptPreKey(store, local, name, deviceId, body);
    if (type === CIPHERTEXT_WHISPER) return await decryptWhisper(store, local, name, deviceId, body);
    if (type === CIPHERTEXT_SENDERKEY) return { plaintext: await decryptSenderKey(store, local, name, deviceId, body), identityChanged: false };
    if (type === CIPHERTEXT_PLAINTEXT) return { plaintext: plaintextContentBody(body), identityChanged: false };
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
    serverGuid: raw.serverGuidBinary.length === 16 ? bytesToUuid(raw.serverGuidBinary) : raw.serverGuid,
    reportSpamToken: raw.reportSpamToken.length ? raw.reportSpamToken : undefined,
    updatedPni: updatedPniFrom(raw.updatedPni, raw.updatedPniBinary),
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

  let decrypted: { plaintext: Uint8Array; identityChanged: boolean };
  if (raw.type === Envelope_Type.UNIDENTIFIED_SENDER) {
    const unsealed = await unseal(store, local, payload);
    if (unsealed.senderUuid === acc.aci && unsealed.senderDeviceId === acc.deviceId) return null;
    env.sourceUuid = unsealed.senderUuid;
    env.sourceE164 = unsealed.senderE164 || undefined;
    env.sourceDevice = unsealed.senderDeviceId;
    decrypted = await decryptInner(
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
    decrypted = await decryptInner(store, local, type, env.sourceUuid, env.sourceDevice, payload, env.timestamp);
  }

  const content = fromBinary(ContentSchema, unpadMessagePlaintext(decrypted.plaintext));
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

  const normalizedFrame = contentToNormalizedFrame(env, content);
  if (decrypted.identityChanged && senderId !== acc.aci) normalizedFrame.envelope.safetyNumberChanged = true;
  return { envelope: env, content, normalizedFrame };
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
