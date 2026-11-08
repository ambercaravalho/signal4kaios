/* Signal Attachment & Profile Avatar encryption and decryption.
 * Signal attachments use a 64-byte composite key (32-byte AES-256-CBC key + 32-byte HMAC-SHA256 key).
 * Wire format on Signal CDN: [16-byte IV][AES-256-CBC ciphertext][32-byte HMAC-SHA256(iv || ciphertext)]
 * Digest: SHA-256(iv || ciphertext || hmac)
 */

import { concatBytes, constantTimeEqual, randomBytes } from '../bytes';
import {
  aesCbcDecrypt,
  aesCbcEncrypt,
  aesGcmDecrypt,
  aesGcmEncrypt,
  hashSha256,
  hmacSha256,
} from './primitives';

export interface EncryptedAttachmentResult {
  key: Uint8Array;        // 64-byte composite key (32B AES + 32B HMAC)
  digest: Uint8Array;     // 32-byte SHA-256 over full encrypted payload
  ciphertext: Uint8Array; // IV (16) + encrypted + MAC (32)
  plaintextLength: number;
}

/**
 * Encrypt an attachment buffer for upload to Signal CDN.
 */
export async function encryptAttachment(
  plaintext: Uint8Array,
  keys64?: Uint8Array
): Promise<EncryptedAttachmentResult> {
  const key = keys64 && keys64.length === 64 ? keys64 : randomBytes(64);
  const aesKey = key.slice(0, 32);
  const macKey = key.slice(32, 64);
  const iv = randomBytes(16);

  const encrypted = await aesCbcEncrypt(aesKey, iv, plaintext);
  const ivAndCipher = concatBytes(iv, encrypted);
  const mac = hmacSha256(macKey, ivAndCipher);
  const fullPayload = concatBytes(ivAndCipher, mac);
  const digest = hashSha256(fullPayload);

  return {
    key,
    digest,
    ciphertext: fullPayload,
    plaintextLength: plaintext.length,
  };
}

/**
 * Verify HMAC + optional SHA-256 digest and decrypt an attachment downloaded from Signal CDN.
 */
export async function decryptAttachment(
  cdnPayload: Uint8Array,
  keys64: Uint8Array,
  expectedDigest?: Uint8Array
): Promise<Uint8Array> {
  if (keys64.length !== 64) {
    throw new Error(`Invalid attachment key length ${keys64.length} (expected 64)`);
  }
  if (cdnPayload.length < 16 + 16 + 32) {
    throw new Error('Encrypted attachment payload too short');
  }

  if (expectedDigest && expectedDigest.length === 32) {
    const actualDigest = hashSha256(cdnPayload);
    if (!constantTimeEqual(actualDigest, expectedDigest)) {
      throw new Error('Attachment SHA-256 digest mismatch');
    }
  }

  const aesKey = keys64.slice(0, 32);
  const macKey = keys64.slice(32, 64);

  const ivAndCipher = cdnPayload.slice(0, cdnPayload.length - 32);
  const theirMac = cdnPayload.slice(cdnPayload.length - 32);
  const ourMac = hmacSha256(macKey, ivAndCipher);

  if (!constantTimeEqual(theirMac, ourMac)) {
    throw new Error('Attachment HMAC verification failed');
  }

  const iv = ivAndCipher.slice(0, 16);
  const ciphertext = ivAndCipher.slice(16);
  return aesCbcDecrypt(aesKey, iv, ciphertext);
}

/**
 * Decrypt a Signal profile field (name, about, or avatar) encrypted with a 32-byte ProfileKey using AES-256-GCM.
 * Wire format: [12-byte nonce][ciphertext + 16-byte GCM tag]
 */
export async function decryptProfileField(
  encrypted: Uint8Array,
  profileKey32: Uint8Array
): Promise<Uint8Array> {
  if (encrypted.length < 12 + 16) {
    throw new Error('Encrypted profile field too short');
  }
  const nonce = encrypted.slice(0, 12);
  const ciphertextAndTag = encrypted.slice(12);
  const padded = await aesGcmDecrypt(profileKey32, nonce, ciphertextAndTag);
  // Profile fields are null-padded; strip trailing 0x00 bytes for text fields
  return padded;
}

export async function encryptProfileField(
  plaintext: Uint8Array,
  profileKey32: Uint8Array,
  paddedLength?: number
): Promise<Uint8Array> {
  const nonce = randomBytes(12);
  let input = plaintext;
  if (paddedLength && paddedLength > plaintext.length) {
    input = new Uint8Array(paddedLength);
    input.set(plaintext, 0);
  }
  const ciphertextAndTag = await aesGcmEncrypt(profileKey32, nonce, input);
  return concatBytes(nonce, ciphertextAndTag);
}
