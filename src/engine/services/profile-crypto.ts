/* The profile cipher and field padding, as Signal-Desktop's Crypto.node.ts and encryptProfileData.preload.ts. */

import { fromBase64, toBase64 } from '../bytes';
import { openGcm, sealGcm } from '../crypto/primitives';

/** Signal-Desktop PaddedLengths. */
export const PADDED_LENGTHS = {
  name: [53, 257],
  about: [128, 254, 512],
  aboutEmoji: [32],
};

export async function encryptProfile(data: Uint8Array, profileKey: Uint8Array): Promise<Uint8Array> {
  if (profileKey.length !== 32) throw new Error('Got invalid length profile key');
  return sealGcm(profileKey, data);
}

export async function decryptProfile(data: Uint8Array, profileKey: Uint8Array): Promise<Uint8Array> {
  if (profileKey.length !== 32) throw new Error('Got invalid length profile key');
  return openGcm(profileKey, data, 1);
}

export async function encryptPadded(item: Uint8Array, profileKey: Uint8Array, lengths: number[]): Promise<Uint8Array> {
  const padded = lengths.find((l) => item.length <= l);
  if (!padded) throw new Error('Oversized value');
  const buf = new Uint8Array(padded);
  buf.set(item);
  return encryptProfile(buf, profileKey);
}

export function untilNul(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}

/** Decrypt a profile `name`: given name up to the first NUL, family name up to the next. */
export async function decryptProfileName(encryptedB64: string, profileKey: Uint8Array): Promise<{ givenName: string; familyName: string; fullName: string }> {
  const padded = await decryptProfile(fromBase64(encryptedB64), profileKey);
  let givenEnd = padded.indexOf(0);
  if (givenEnd < 0) givenEnd = padded.length;
  const givenName = new TextDecoder().decode(padded.subarray(0, givenEnd));
  const familyName = givenEnd + 1 < padded.length ? untilNul(padded.subarray(givenEnd + 1)) : '';
  return { givenName, familyName, fullName: [givenName, familyName].filter(Boolean).join(' ') };
}

export async function encryptProfileName(givenName: string, familyName: string, profileKey: Uint8Array): Promise<string> {
  const full = [givenName, familyName].filter(Boolean).join('\0');
  return toBase64(await encryptPadded(new TextEncoder().encode(full), profileKey, PADDED_LENGTHS.name));
}
