/* Curve25519 ECDH & Signal XEdDSA (Curve25519 signing/verification) primitives.
 * Built on @noble/curves/ed25519 and @noble/hashes/sha512.
 * Signal prefixes Curve25519 public keys with version byte 0x05 (DJB type).
 */

import { x25519, ed25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { concatBytes, randomBytes } from '../bytes';
import type { KeyPair } from '../storage';

export const DJB_TYPE = 0x05;

const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

function bytesToNumberLE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return value;
}

function numberToBytesLE(num: bigint, len = 32): Uint8Array {
  let n = ((num % L) + L) % L;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function modP(a: bigint): bigint {
  const r = a % P;
  return r >= 0n ? r : r + P;
}

function powModP(base: bigint, exp: bigint): bigint {
  let res = 1n;
  let b = modP(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) res = modP(res * b);
    b = modP(b * b);
    e >>= 1n;
  }
  return res;
}

function invModP(a: bigint): bigint {
  return powModP(a, P - 2n);
}

/** Clamp a 32-byte Curve25519 private scalar according to RFC 7748 */
export function clampScalar(scalar: Uint8Array): Uint8Array {
  const out = new Uint8Array(scalar);
  out[0] &= 248;
  out[31] &= 127;
  out[31] |= 64;
  return out;
}

/** Ensure a Curve25519 public key has the 33-byte 0x05 Signal prefix */
export function prependVersionByte(pubKey: Uint8Array): Uint8Array {
  if (pubKey.length === 33 && pubKey[0] === DJB_TYPE) return pubKey;
  if (pubKey.length === 32) {
    const out = new Uint8Array(33);
    out[0] = DJB_TYPE;
    out.set(pubKey, 1);
    return out;
  }
  throw new Error(`Invalid Curve25519 public key length: ${pubKey.length}`);
}

/** Strip the 0x05 Signal prefix from a 33-byte public key to get the raw 32-byte u-coordinate */
export function stripVersionByte(pubKey: Uint8Array): Uint8Array {
  if (pubKey.length === 33 && pubKey[0] === DJB_TYPE) {
    return pubKey.slice(1);
  }
  if (pubKey.length === 32) {
    return pubKey;
  }
  throw new Error(`Invalid Curve25519 public key length: ${pubKey.length}`);
}

/** Generate a Signal Curve25519 key pair (33-byte prefixed pubKey, 32-byte clamped privKey) */
export function generateKeyPair(): KeyPair {
  const privKey = clampScalar(randomBytes(32));
  const rawPub = x25519.getPublicKey(privKey);
  return {
    pubKey: prependVersionByte(rawPub),
    privKey,
  };
}

/** Derive the 33-byte public key from a 32-byte private key */
export function keyPairFromPrivate(privKey: Uint8Array): KeyPair {
  const clamped = clampScalar(privKey);
  const rawPub = x25519.getPublicKey(clamped);
  return {
    pubKey: prependVersionByte(rawPub),
    privKey: clamped,
  };
}

/** Compute 32-byte X25519 shared secret */
export function calculateAgreement(pubKey: Uint8Array, privKey: Uint8Array): Uint8Array {
  const rawPub = stripVersionByte(pubKey);
  return x25519.getSharedSecret(privKey, rawPub);
}

function modL(a: bigint): bigint {
  const r = a % L;
  return r >= 0n ? r : r + L;
}

/**
 * Signal XEdDSA signature generation (64-byte signature over message using Curve25519 private key).
 * Compatible with libsignal-protocol-javascript / curve25519-js / Signal Android/Desktop.
 */
export function calculateSignature(privKey: Uint8Array, message: Uint8Array): Uint8Array {
  const clamped = clampScalar(privKey);
  const aScalar = modL(bytesToNumberLE(clamped));

  // Compute Edwards point A = aScalar * B
  const edPoint = ed25519.ExtendedPoint.BASE.multiply(aScalar);
  const edPubBytes = edPoint.toRawBytes();
  const signBit = (edPubBytes[31] & 0x80) !== 0;

  // In XEdDSA, we force the Edwards public key sign bit to 0 by negating the scalar if signBit is 1
  const a = signBit ? modL(L - aScalar) : aScalar;
  const A = new Uint8Array(edPubBytes);
  A[31] &= 0x7f;

  // Deterministic/hedged nonce r = SHA-512(prefix || a_bytes || message || random64) mod L
  const prefix = new Uint8Array(32);
  prefix.fill(0xff);
  prefix[0] = 0xfe;
  const aBytes = numberToBytesLE(a, 32);
  const rand = randomBytes(64);
  const rHash = sha512(concatBytes(prefix, aBytes, message, rand));
  const r = modL(bytesToNumberLE(rHash)) || 1n;

  const RPoint = ed25519.ExtendedPoint.BASE.multiply(r);
  const R = RPoint.toRawBytes();

  // Challenge k = SHA-512(R || A || message) mod L
  const kHash = sha512(concatBytes(R, A, message));
  const k = modL(bytesToNumberLE(kHash));

  // s = (r + k * a) mod L
  const s = modL(r + k * a);
  const sBytes = numberToBytesLE(s, 32);
  if (signBit) {
    sBytes[31] |= 0x80;
  } else {
    sBytes[31] &= 0x7f;
  }

  return concatBytes(R, sBytes);
}

/**
 * Verify a 64-byte Signal XEdDSA signature using a 32-byte or 33-byte Curve25519 public key.
 */
export function verifySignature(pubKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  try {
    const rawU = stripVersionByte(pubKey);
    const uClean = new Uint8Array(rawU);
    uClean[31] &= 0x7f;
    const u = bytesToNumberLE(uClean);
    if (u >= P) return false;

    // Birational map from Montgomery u to Edwards y: y = (u - 1) / (u + 1) mod p
    const y = modP((u - 1n) * invModP(u + 1n));
    const signBit = (signature[63] & 0x80) !== 0;

    const A = new Uint8Array(32);
    let yTemp = y;
    for (let i = 0; i < 32; i++) {
      A[i] = Number(yTemp & 0xffn);
      yTemp >>= 8n;
    }
    if (signBit) A[31] |= 0x80;
    else A[31] &= 0x7f;

    const R = signature.slice(0, 32);
    const sClean = new Uint8Array(signature.slice(32, 64));
    sClean[31] &= 0x7f;
    const s = bytesToNumberLE(sClean);
    if (s === 0n || s >= L) return false;

    const APoint = ed25519.ExtendedPoint.fromHex(A);
    const RPoint = ed25519.ExtendedPoint.fromHex(R);

    // Note: in calculateSignature, A[31] had signBit=0 during challenge hash
    const AForHash = new Uint8Array(A);
    AForHash[31] &= 0x7f;

    const kHash0 = sha512(concatBytes(R, AForHash, message));
    const k0 = modL(bytesToNumberLE(kHash0));
    const lhs = ed25519.ExtendedPoint.BASE.multiply(s);

    const A0Point = ed25519.ExtendedPoint.fromHex(AForHash);
    const rhs0 = k0 === 0n ? RPoint : RPoint.add(A0Point.multiply(k0));
    if (lhs.equals(rhs0)) return true;

    const kHash1 = sha512(concatBytes(R, A, message));
    const k1 = modL(bytesToNumberLE(kHash1));
    const rhs1 = k1 === 0n ? RPoint : RPoint.add(APoint.multiply(k1));
    return lhs.equals(rhs1);
  } catch {
    return false;
  }
}
