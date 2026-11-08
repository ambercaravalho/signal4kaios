/* Signal Safety Number (60-digit numeric fingerprint + scannable QR payload) generator.
 * Implements Signal's NumericFingerprintGenerator (5200 iterations of SHA-512 over
 * version + publicIdentityKey + stableIdentifier/UUID).
 */

import { concatBytes, uuidToBytes } from '../bytes';
import { prependVersionByte } from '../crypto/curve';
import { hashSha512 } from '../crypto/primitives';
import { ProtoReader, ProtoWriter } from '../proto';

const FINGERPRINT_VERSION = 0; // v1 (0x0000) or v2 (0x0001 for UUID)
const DEFAULT_ITERATIONS = 5200;

function identifierBytes(identifier: string): Uint8Array {
  // If identifier is a standard UUID, Signal v2 fingerprints use the 16-byte binary UUID
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(identifier)) {
    return uuidToBytes(identifier);
  }
  return new TextEncoder().encode(identifier);
}

function versionShortBytes(identifier: string): Uint8Array {
  const isUuid =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      identifier
    );
  return new Uint8Array([0x00, isUuid ? 0x01 : FINGERPRINT_VERSION]);
}

function iterateHash(
  identifier: string,
  identityKey: Uint8Array,
  iterations = DEFAULT_ITERATIONS
): Uint8Array {
  const pubKey = prependVersionByte(identityKey);
  const idBytes = identifierBytes(identifier);
  const verBytes = versionShortBytes(identifier);

  let current = concatBytes(verBytes, pubKey, idBytes);
  for (let i = 0; i < iterations; i++) {
    current = hashSha512(concatBytes(current, pubKey));
  }
  return current;
}

function getEncodedChunk(hash: Uint8Array, offset: number): string {
  // 5-byte little/big-endian chunk mod 100000 formatted as 5 digits
  const chunk =
    ((BigInt(hash[offset]) << 32n) |
      (BigInt(hash[offset + 1]) << 24n) |
      (BigInt(hash[offset + 2]) << 16n) |
      (BigInt(hash[offset + 3]) << 8n) |
      BigInt(hash[offset + 4])) %
    100000n;
  return chunk.toString(10).padStart(5, '0');
}

function getDisplayStringFor(identifier: string, identityKey: Uint8Array): string {
  const digest = iterateHash(identifier, identityKey);
  return (
    getEncodedChunk(digest, 0) +
    getEncodedChunk(digest, 5) +
    getEncodedChunk(digest, 10) +
    getEncodedChunk(digest, 15) +
    getEncodedChunk(digest, 20) +
    getEncodedChunk(digest, 25)
  );
}

export interface SafetyNumberResult {
  safetyNumber: string;       // 60-digit string (sorted halves)
  scannableQrBytes: Uint8Array; // CombinedFingerprints protobuf for QR code verification
}

/**
 * Compute the 60-digit safety number and scannable QR protobuf for a local + remote identity pair.
 */
export function generateSafetyNumber(
  localIdentifier: string,
  localIdentityKey: Uint8Array,
  remoteIdentifier: string,
  remoteIdentityKey: Uint8Array
): SafetyNumberResult {
  const localHalf = getDisplayStringFor(localIdentifier, localIdentityKey);
  const remoteHalf = getDisplayStringFor(remoteIdentifier, remoteIdentityKey);

  const safetyNumber =
    localHalf <= remoteHalf ? localHalf + remoteHalf : remoteHalf + localHalf;

  const localPub = prependVersionByte(localIdentityKey);
  const remotePub = prependVersionByte(remoteIdentityKey);

  // Scannable CombinedFingerprints protobuf:
  // message LogicalFingerprint { optional bytes content = 1; }
  // message CombinedFingerprints { optional uint32 version = 1; optional LogicalFingerprint localFingerprint = 2; optional LogicalFingerprint remoteFingerprint = 3; }
  const localHash = iterateHash(localIdentifier, localPub).slice(0, 32);
  const remoteHash = iterateHash(remoteIdentifier, remotePub).slice(0, 32);

  const w = new ProtoWriter();
  w.writeUint32(1, 1);
  w.writeMessage(2, localHash, (lh, lw) => lw.writeBytes(1, lh));
  w.writeMessage(3, remoteHash, (rh, rw) => rw.writeBytes(1, rh));

  return {
    safetyNumber,
    scannableQrBytes: w.finish(),
  };
}

/**
 * Verify a scanned safety number QR code (CombinedFingerprints protobuf) against our expected pair.
 */
export function verifyScannedSafetyNumber(
  scannedBytes: Uint8Array,
  expected: SafetyNumberResult
): boolean {
  try {
    const parseCombined = (buf: Uint8Array) => {
      const r = new ProtoReader(buf);
      let localContent: Uint8Array | null = null;
      let remoteContent: Uint8Array | null = null;
      while (!r.eof()) {
        const { fieldNumber, wireType } = r.readTag();
        if (fieldNumber === 2) {
          const sr = new ProtoReader(r.readBytes());
          while (!sr.eof()) {
            const st = sr.readTag();
            if (st.fieldNumber === 1) localContent = sr.readBytes();
            else sr.skipField(st.wireType);
          }
        } else if (fieldNumber === 3) {
          const sr = new ProtoReader(r.readBytes());
          while (!sr.eof()) {
            const st = sr.readTag();
            if (st.fieldNumber === 1) remoteContent = sr.readBytes();
            else sr.skipField(st.wireType);
          }
        } else {
          r.skipField(wireType);
        }
      }
      return { localContent, remoteContent };
    };

    const scanned = parseCombined(scannedBytes);
    const ours = parseCombined(expected.scannableQrBytes);
    if (!scanned.localContent || !scanned.remoteContent || !ours.localContent || !ours.remoteContent) {
      return false;
    }

    // Scanned local matches our remote AND scanned remote matches our local
    const eq = (a: Uint8Array, b: Uint8Array) =>
      a.length === b.length && a.every((v, i) => v === b[i]);

    return (
      (eq(scanned.localContent, ours.remoteContent) &&
        eq(scanned.remoteContent, ours.localContent)) ||
      (eq(scanned.localContent, ours.localContent) &&
        eq(scanned.remoteContent, ours.remoteContent))
    );
  } catch {
    return false;
  }
}
