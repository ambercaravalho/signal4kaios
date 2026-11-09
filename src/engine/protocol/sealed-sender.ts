/* Sealed Sender (Unidentified Delivery v1/v2) encryption and decryption.
 * Handles EnvelopeType.UNIDENTIFIED_SENDER (type 6) using ephemeral+static ECDH
 * and AES-256-CTR + HMAC-SHA256.
 */

import { concatBytes, constantTimeEqual } from '../bytes';
import {
  calculateAgreement,
  generateKeyPair,
  prependVersionByte,
} from '../crypto/curve';
import {
  aesCtrCrypt,
  aesGcmEncrypt,
  hkdfSha256,
  hmacSha256,
} from '../crypto/primitives';
import {
  decodeSenderCertificateDetails,
  decodeUnidentifiedSenderMessage,
  decodeUnidentifiedSenderMessageContent,
  encodeUnidentifiedSenderMessage,
  encodeUnidentifiedSenderMessageContent,
  SenderCertificate,
  UnidentifiedMessageType,
} from '../proto';
import type { SignalProtocolStore } from '../storage';
import {
  decryptPreKeyWhisperMessage,
  decryptWhisperMessage,
  encryptWhisperMessage,
} from './session';

const UNIDENTIFIED_VERSION_BYTE = 0x11; // (1 << 4) | 1

/**
 * Derive the 16-byte UnidentifiedAccessKey from a contact's 32-byte ProfileKey:
 * AES-256-GCM(key = profileKey, nonce = 0x00^12, plaintext = 0x00^16) -> first 16 bytes (ciphertext).
 */
export async function deriveUnidentifiedAccessKey(
  profileKey32: Uint8Array
): Promise<Uint8Array> {
  if (profileKey32.length !== 32) {
    throw new Error(`Invalid profileKey length: ${profileKey32.length}`);
  }
  const zeroNonce = new Uint8Array(12);
  const zeroPlain = new Uint8Array(16);
  const cipherAndTag = await aesGcmEncrypt(profileKey32, zeroNonce, zeroPlain);
  return cipherAndTag.slice(0, 16);
}

export interface DecryptedSealedSenderResult {
  senderUuid?: string;
  senderE164?: string;
  senderDevice: number;
  senderIdentityKey: Uint8Array;
  plaintext: Uint8Array;
  groupId?: Uint8Array;
}

function deriveEphemeralKeys(
  ecdhSecret: Uint8Array,
  ephemeralPub: Uint8Array,
  recipientPub: Uint8Array
): { chainKey: Uint8Array; cipherKey: Uint8Array; macKey: Uint8Array } {
  const salt = concatBytes(
    new TextEncoder().encode('UnidentifiedDelivery'),
    prependVersionByte(recipientPub),
    prependVersionByte(ephemeralPub)
  );
  const out = hkdfSha256(ecdhSecret, new Uint8Array(0), 96, salt);
  return {
    chainKey: out.slice(0, 32),
    cipherKey: out.slice(32, 64),
    macKey: out.slice(64, 96),
  };
}

function deriveStaticKeys(
  staticEcdhSecret: Uint8Array,
  chainKey: Uint8Array,
  encryptedStatic: Uint8Array
): { cipherKey: Uint8Array; macKey: Uint8Array } {
  const salt = concatBytes(chainKey, encryptedStatic);
  const out = hkdfSha256(staticEcdhSecret, new Uint8Array(0), 64, salt);
  return {
    cipherKey: out.slice(0, 32),
    macKey: out.slice(32, 64),
  };
}

async function encryptCtrWithMac(
  cipherKey: Uint8Array,
  macKey: Uint8Array,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  const zeroIv = new Uint8Array(16);
  const ciphertext = await aesCtrCrypt(cipherKey, zeroIv, plaintext);
  const mac = hmacSha256(macKey, plaintext).slice(0, 10);
  return concatBytes(ciphertext, mac);
}

async function decryptCtrWithMac(
  cipherKey: Uint8Array,
  macKey: Uint8Array,
  ciphertextAndMac: Uint8Array
): Promise<Uint8Array> {
  if (ciphertextAndMac.length < 10) {
    throw new Error('Sealed sender payload shorter than 10-byte MAC');
  }
  const ciphertext = ciphertextAndMac.slice(0, ciphertextAndMac.length - 10);
  const theirMac = ciphertextAndMac.slice(ciphertextAndMac.length - 10);
  const zeroIv = new Uint8Array(16);
  const plaintext = await aesCtrCrypt(cipherKey, zeroIv, ciphertext);
  const ourMac = hmacSha256(macKey, plaintext).slice(0, 10);
  if (!constantTimeEqual(theirMac, ourMac)) {
    throw new Error('Bad MAC in Sealed Sender envelope');
  }
  return plaintext;
}

/**
 * Encrypt an outgoing message using Sealed Sender (UnidentifiedSenderMessage).
 */
export async function sealSenderMessage(
  store: SignalProtocolStore,
  recipientAddress: string,
  senderCertificate: SenderCertificate,
  paddedPlaintext: Uint8Array,
  groupId?: Uint8Array
): Promise<Uint8Array> {
  const ourIdentity = await store.getIdentityKeyPair();
  const recipientUuid = recipientAddress.split('.')[0];
  const recipientIdentity = await store.getIdentity(recipientUuid);
  if (!recipientIdentity) {
    throw new Error(`Missing identity key for sealed sender recipient ${recipientUuid}`);
  }

  const encryptedInner = await encryptWhisperMessage(store, recipientAddress, paddedPlaintext);
  const msgType =
    encryptedInner.type === 3
      ? UnidentifiedMessageType.PREKEY_MESSAGE
      : UnidentifiedMessageType.MESSAGE;

  const contentBytes = encodeUnidentifiedSenderMessageContent({
    type: msgType,
    senderCertificate,
    content: encryptedInner.body,
    groupId,
  });

  const ephemeral = generateKeyPair();
  const ephSecret = calculateAgreement(recipientIdentity.publicKey, ephemeral.privKey);
  const ephKeys = deriveEphemeralKeys(
    ephSecret,
    ephemeral.pubKey,
    recipientIdentity.publicKey
  );

  const staticPub = prependVersionByte(ourIdentity.pubKey);
  const encryptedStatic = await encryptCtrWithMac(
    ephKeys.cipherKey,
    ephKeys.macKey,
    staticPub
  );

  const staticSecret = calculateAgreement(recipientIdentity.publicKey, ourIdentity.privKey);
  const staticKeys = deriveStaticKeys(staticSecret, ephKeys.chainKey, encryptedStatic);

  const encryptedMessage = await encryptCtrWithMac(
    staticKeys.cipherKey,
    staticKeys.macKey,
    contentBytes
  );

  const usmBytes = encodeUnidentifiedSenderMessage({
    ephemeralPublic: prependVersionByte(ephemeral.pubKey),
    encryptedStatic,
    encryptedMessage,
  });

  return concatBytes(new Uint8Array([UNIDENTIFIED_VERSION_BYTE]), usmBytes);
}

/**
 * Decrypt an incoming UnidentifiedSenderMessage (EnvelopeType.UNIDENTIFIED_SENDER).
 */
export async function unsealSenderMessage(
  store: SignalProtocolStore,
  sealedBytes: Uint8Array
): Promise<DecryptedSealedSenderResult> {
  if (sealedBytes.length < 2) {
    throw new Error('UnidentifiedSenderMessage too short');
  }
  const version = sealedBytes[0] >>> 4;
  if (version < 1 || version > 2) {
    throw new Error(`Unsupported UnidentifiedSenderMessage version ${version}`);
  }

  const usm = decodeUnidentifiedSenderMessage(sealedBytes.slice(1));
  if (!usm.ephemeralPublic || !usm.encryptedStatic || !usm.encryptedMessage) {
    throw new Error('Incomplete UnidentifiedSenderMessage');
  }

  const ourIdentity = await store.getIdentityKeyPair();
  const ephSecret = calculateAgreement(usm.ephemeralPublic, ourIdentity.privKey);
  const ephKeys = deriveEphemeralKeys(
    ephSecret,
    usm.ephemeralPublic,
    ourIdentity.pubKey
  );

  const staticPub = await decryptCtrWithMac(
    ephKeys.cipherKey,
    ephKeys.macKey,
    usm.encryptedStatic
  );

  const staticSecret = calculateAgreement(staticPub, ourIdentity.privKey);
  const staticKeys = deriveStaticKeys(staticSecret, ephKeys.chainKey, usm.encryptedStatic);

  const contentBytes = await decryptCtrWithMac(
    staticKeys.cipherKey,
    staticKeys.macKey,
    usm.encryptedMessage
  );

  const content = decodeUnidentifiedSenderMessageContent(contentBytes);
  if (!content.senderCertificate || !content.senderCertificate.certificate || !content.content) {
    throw new Error('Malformed UnidentifiedSenderMessageContent');
  }

  const certDetails = decodeSenderCertificateDetails(content.senderCertificate.certificate);
  if (!certDetails.identityKey || (!certDetails.senderUuid && !certDetails.senderE164)) {
    throw new Error('Incomplete SenderCertificate');
  }

  const certPub = prependVersionByte(certDetails.identityKey);
  if (!constantTimeEqual(certPub, prependVersionByte(staticPub))) {
    throw new Error('SenderCertificate identity key does not match static key');
  }

  const senderId = certDetails.senderUuid || certDetails.senderE164!;
  const senderDevice = certDetails.senderDevice || 1;
  const senderAddress = `${senderId}.${senderDevice}`;

  await store.saveIdentity(senderId, certPub, {
    number: certDetails.senderE164,
    uuid: certDetails.senderUuid,
  });

  let plaintext: Uint8Array;
  if (content.type === UnidentifiedMessageType.PREKEY_MESSAGE) {
    plaintext = await decryptPreKeyWhisperMessage(store, senderAddress, content.content);
  } else if (content.type === UnidentifiedMessageType.MESSAGE) {
    plaintext = await decryptWhisperMessage(store, senderAddress, content.content);
  } else if (content.type === UnidentifiedMessageType.PLAINTEXT_CONTENT) {
    plaintext = content.content;
  } else {
    throw new Error(`Unsupported UnidentifiedSender inner type ${content.type}`);
  }

  return {
    senderUuid: certDetails.senderUuid,
    senderE164: certDetails.senderE164,
    senderDevice,
    senderIdentityKey: certPub,
    plaintext,
    groupId: content.groupId,
  };
}
