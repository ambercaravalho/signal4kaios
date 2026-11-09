/* Symmetric primitives: HKDF-SHA256, HMAC-SHA256, SHA-256, SHA-512, AES-CBC, AES-GCM, AES-CTR.
 * Uses @noble/hashes for synchronous HKDF/HMAC/SHA and WebCrypto (crypto.subtle) for AES.
 */

import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { concatBytes } from '../bytes';

export function hashSha256(data: Uint8Array): Uint8Array {
  return sha256(data);
}

export function hashSha512(data: Uint8Array): Uint8Array {
  return sha512(data);
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha256, key, data);
}

/**
 * Signal v3 HKDF-SHA256 (RFC 5869, salt defaults to 32 zero bytes when empty).
 */
export function hkdfSha256(
  ikm: Uint8Array,
  info: Uint8Array | string,
  length: number,
  salt?: Uint8Array
): Uint8Array {
  const actualSalt = salt && salt.length > 0 ? salt : new Uint8Array(32);
  const infoBytes = typeof info === 'string' ? new TextEncoder().encode(info) : info;
  return hkdf(sha256, ikm, actualSalt, infoBytes, length);
}

function subtle(): SubtleCrypto {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  throw new Error('WebCrypto (crypto.subtle) is required');
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

export async function aesCbcEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await subtle().importKey('raw', toArrayBuffer(key), { name: 'AES-CBC' }, false, [
    'encrypt',
  ]);
  const encrypted = await subtle().encrypt(
    { name: 'AES-CBC', iv: toArrayBuffer(iv) },
    cryptoKey,
    toArrayBuffer(plaintext)
  );
  return new Uint8Array(encrypted);
}

export async function aesCbcDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await subtle().importKey('raw', toArrayBuffer(key), { name: 'AES-CBC' }, false, [
    'decrypt',
  ]);
  const decrypted = await subtle().decrypt(
    { name: 'AES-CBC', iv: toArrayBuffer(iv) },
    cryptoKey,
    toArrayBuffer(ciphertext)
  );
  return new Uint8Array(decrypted);
}

export async function aesCtrCrypt(
  key: Uint8Array,
  counterIv: Uint8Array,
  data: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await subtle().importKey('raw', toArrayBuffer(key), { name: 'AES-CTR' }, false, [
    'encrypt',
  ]);
  const out = await subtle().encrypt(
    { name: 'AES-CTR', counter: toArrayBuffer(counterIv), length: 64 },
    cryptoKey,
    toArrayBuffer(data)
  );
  return new Uint8Array(out);
}

export async function aesGcmEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await subtle().importKey('raw', toArrayBuffer(key), { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);
  const params: AesGcmParams = { name: 'AES-GCM', iv: toArrayBuffer(iv), tagLength: 128 };
  if (aad) params.additionalData = toArrayBuffer(aad);
  const encrypted = await subtle().encrypt(params, cryptoKey, toArrayBuffer(plaintext));
  return new Uint8Array(encrypted);
}

export async function aesGcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertextAndTag: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await subtle().importKey('raw', toArrayBuffer(key), { name: 'AES-GCM' }, false, [
    'decrypt',
  ]);
  const params: AesGcmParams = { name: 'AES-GCM', iv: toArrayBuffer(iv), tagLength: 128 };
  if (aad) params.additionalData = toArrayBuffer(aad);
  const decrypted = await subtle().decrypt(params, cryptoKey, toArrayBuffer(ciphertextAndTag));
  return new Uint8Array(decrypted);
}

/**
 * Signal message padding (ISO/IEC 7816-4: 0x80 followed by 0x00 bytes to 160-byte block boundary).
 */
export function padMessagePlaintext(plaintext: Uint8Array): Uint8Array {
  // Signal pads plaintext with 0x80 and 0x00s to obscure exact length
  const blockSize = 160;
  const paddedLen = Math.ceil((plaintext.length + 2) / blockSize) * blockSize - 1;
  const out = new Uint8Array(Math.max(paddedLen, plaintext.length + 1));
  out.set(plaintext, 0);
  out[plaintext.length] = 0x80;
  return out;
}

export function unpadMessagePlaintext(padded: Uint8Array): Uint8Array {
  for (let i = padded.length - 1; i >= 0; i--) {
    if (padded[i] === 0x80) {
      return padded.slice(0, i);
    }
    if (padded[i] !== 0x00) {
      // Unpadded payload fallback
      return padded;
    }
  }
  return padded;
}
