/* Signal PQXDH Post-Quantum KEM (Kyber-1024 / ML-KEM-1024) primitives.
 * Signal prefixes Kyber-1024 public keys with version byte 0x08 (KYBER_1024_TYPE).
 * Uses @noble/post-quantum/ml-kem (ml_kem1024).
 */

import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { concatBytes, randomBytes } from '../bytes';
import { calculateSignature, verifySignature } from './curve';

export const KYBER_1024_TYPE = 0x08;
export const KYBER_1024_PUBLIC_KEY_LEN = 1568; // raw ML-KEM-1024 public key length

export interface KyberKeyPair {
  pubKey: Uint8Array;  // 1569 bytes (0x08 + 1568-byte raw public key)
  privKey: Uint8Array; // 3168-byte raw secret key
}

export interface KyberPreKeyRecord {
  keyId: number;
  keyPair: KyberKeyPair;
  signature: Uint8Array;
  timestamp: number;
  isLastResort?: boolean;
}

export function prependKyberVersionByte(pubKey: Uint8Array): Uint8Array {
  if (pubKey.length === KYBER_1024_PUBLIC_KEY_LEN + 1 && pubKey[0] === KYBER_1024_TYPE) {
    return pubKey;
  }
  if (pubKey.length === KYBER_1024_PUBLIC_KEY_LEN) {
    return concatBytes(new Uint8Array([KYBER_1024_TYPE]), pubKey);
  }
  throw new Error(`Invalid Kyber-1024 public key length: ${pubKey.length}`);
}

export function stripKyberVersionByte(pubKey: Uint8Array): Uint8Array {
  if (pubKey.length === KYBER_1024_PUBLIC_KEY_LEN + 1 && pubKey[0] === KYBER_1024_TYPE) {
    return pubKey.slice(1);
  }
  if (pubKey.length === KYBER_1024_PUBLIC_KEY_LEN) {
    return pubKey;
  }
  throw new Error(`Invalid Kyber-1024 public key length: ${pubKey.length}`);
}

/**
 * Generate a fresh Kyber-1024 / ML-KEM-1024 key pair.
 */
export function generateKyberKeyPair(): KyberKeyPair {
  const seed = randomBytes(64);
  const { publicKey, secretKey } = ml_kem1024.keygen(seed);
  return {
    pubKey: prependKyberVersionByte(publicKey),
    privKey: secretKey,
  };
}

/**
 * Generate a signed Kyber-1024 PreKeyRecord signed with our Curve25519 identity private key.
 */
export function generateSignedKyberPreKey(
  identityPrivKey: Uint8Array,
  keyId: number,
  isLastResort = false
): KyberPreKeyRecord {
  const keyPair = generateKyberKeyPair();
  const signature = calculateSignature(identityPrivKey, keyPair.pubKey);
  return {
    keyId,
    keyPair,
    signature,
    timestamp: Date.now(),
    isLastResort,
  };
}

/**
 * Verify a remote Kyber-1024 PreKey's XEdDSA signature against the peer's Curve25519 identity key.
 */
export function verifyKyberPreKeySignature(
  remoteIdentityPubKey: Uint8Array,
  kyberPubKey: Uint8Array,
  signature: Uint8Array
): boolean {
  const prefixed = prependKyberVersionByte(kyberPubKey);
  return verifySignature(remoteIdentityPubKey, prefixed, signature);
}

/**
 * Encapsulate a 32-byte shared secret against a recipient's Kyber-1024 public key.
 */
export function kyberEncapsulate(remoteKyberPubKey: Uint8Array): {
  ciphertext: Uint8Array;
  sharedSecret: Uint8Array;
} {
  const rawPub = stripKyberVersionByte(remoteKyberPubKey);
  const { cipherText, sharedSecret } = ml_kem1024.encapsulate(rawPub, randomBytes(32));
  return {
    ciphertext: cipherText,
    sharedSecret,
  };
}

/**
 * Decapsulate a 32-byte shared secret from a Kyber-1024 ciphertext using our secret key.
 */
export function kyberDecapsulate(
  kyberCiphertext: Uint8Array,
  localKyberPrivKey: Uint8Array
): Uint8Array {
  return ml_kem1024.decapsulate(kyberCiphertext, localKyberPrivKey);
}
