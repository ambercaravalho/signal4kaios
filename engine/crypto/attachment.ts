/* Signal attachment encryption and decryption (Signal-Desktop AttachmentCrypto).
 * Signal attachments use a 64-byte composite key (32-byte AES-256-CBC key + 32-byte HMAC-SHA256 key).
 * Wire format on Signal CDN: [16-byte IV][AES-256-CBC ciphertext][32-byte HMAC-SHA256(iv || ciphertext)]
 * Digest: SHA-256(iv || ciphertext || hmac)
 */

import { concatBytes, constantTimeEqual, randomBytes } from '../bytes';
import { aesCbcDecrypt, aesCbcEncrypt, hashSha256, hmacSha256 } from './primitives';

export interface EncryptedAttachmentResult {
  key: Uint8Array;        // 64-byte composite key (32B AES + 32B HMAC)
  digest: Uint8Array;     // 32-byte SHA-256 over full encrypted payload
  ciphertext: Uint8Array; // IV (16) + encrypted + MAC (32)
  plaintextLength: number;
}

/** Signal-Desktop's logPadSize: plaintext is zero-padded to a 1.05^n bucket (minimum 541 bytes) so ciphertext sizes leak less. */
export function attachmentPaddedSize(size: number): number {
  return Math.max(541, Math.floor(1.05 ** Math.ceil(Math.log(size) / Math.log(1.05))));
}

/**
 * Pad and encrypt an attachment buffer for upload to Signal CDN; the pointer's `size` must carry the unpadded length.
 */
export async function encryptAttachment(
  plaintext: Uint8Array,
  keys64?: Uint8Array
): Promise<EncryptedAttachmentResult> {
  const key = keys64 && keys64.length === 64 ? keys64 : randomBytes(64);
  const aesKey = key.slice(0, 32);
  const macKey = key.slice(32, 64);
  const iv = randomBytes(16);

  const padded = new Uint8Array(attachmentPaddedSize(plaintext.length));
  padded.set(plaintext);
  const encrypted = await aesCbcEncrypt(aesKey, iv, padded);
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
