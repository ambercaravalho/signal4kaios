/* Signal profiles, profile avatars, and username lookup. The profile cipher, padding, and request bodies follow Signal-Desktop (Crypto.node.ts, encryptProfileData.preload.ts, WebAPI getProfile/putProfile); profile key versions, commitments, access keys, and username hashes come from libsignal (zkgroup, usernames). */

import { fromBase64, randomBytes, toBase64 } from './bytes';
import { aesGcmDecrypt, aesGcmEncrypt } from './crypto/primitives';
import { libsignal } from './libsignal';
import type { SignalHttpJsonFn } from './provisioning';
import type { SignalProtocolStore } from './storage';
import { DEFAULT_SIGNAL_CDN, DEFAULT_SIGNAL_SERVER, SignalHttpBinaryFn } from './transport';

/** Signal-Desktop PaddedLengths. */
const PADDED_LENGTHS = {
  name: [53, 257],
  about: [128, 254, 512],
  aboutEmoji: [32],
};

export interface DecryptedProfile {
  uuid: string;
  identityKey?: Uint8Array;
  givenName: string;
  familyName: string;
  fullName: string;
  about: string;
  aboutEmoji: string;
  avatarUrlPath?: string;
  phoneNumberSharing?: string;
  unidentifiedAccess?: string;
  unrestrictedUnidentifiedAccess?: boolean;
}

export async function encryptProfile(data: Uint8Array, profileKey: Uint8Array): Promise<Uint8Array> {
  if (profileKey.length !== 32) throw new Error('Got invalid length profile key');
  const iv = randomBytes(12);
  const ct = await aesGcmEncrypt(profileKey, iv, data);
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export async function decryptProfile(data: Uint8Array, profileKey: Uint8Array): Promise<Uint8Array> {
  if (data.length < 12 + 16 + 1) throw new Error(`Got too short input: ${data.length}`);
  if (profileKey.length !== 32) throw new Error('Got invalid length profile key');
  return aesGcmDecrypt(profileKey, data.subarray(0, 12), data.subarray(12));
}

async function encryptPadded(item: Uint8Array, profileKey: Uint8Array, lengths: number[]): Promise<Uint8Array> {
  const padded = lengths.find((l) => item.length <= l);
  if (!padded) throw new Error('Oversized value');
  const buf = new Uint8Array(padded);
  buf.set(item);
  return encryptProfile(buf, profileKey);
}

function untilNul(bytes: Uint8Array): string {
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

/**
 * Fetch a profile with `GET /v1/profile/{aci}/{version}` (the versioned path returns the fields encrypted under that profile key) and decrypt it.
 */
export async function fetchAndDecryptProfile(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  aci: string,
  profileKey?: Uint8Array,
  serverUrl = DEFAULT_SIGNAL_SERVER
): Promise<DecryptedProfile | null> {
  const acc = await store.getAccount();
  if (!acc) return null;
  const hasKey = !!profileKey && profileKey.length === 32;
  const path = hasKey
    ? `/v1/profile/${encodeURIComponent(aci)}/${libsignal.profileKeyGetVersion(profileKey!, aci)}`
    : `/v1/profile/${encodeURIComponent(aci)}`;

  const res = await httpJson('GET', path, null, {
    baseUrl: serverUrl,
    basicAuth: { username: `${acc.aci}.${acc.deviceId}`, password: acc.password },
    timeout: 15000,
  });
  if (!res) return null;

  const out: DecryptedProfile = {
    uuid: aci,
    givenName: '',
    familyName: '',
    fullName: '',
    about: '',
    aboutEmoji: '',
    avatarUrlPath: typeof res.avatar === 'string' ? res.avatar : undefined,
    phoneNumberSharing: typeof res.phoneNumberSharing === 'string' ? res.phoneNumberSharing : undefined,
    unidentifiedAccess: res.unidentifiedAccess,
    unrestrictedUnidentifiedAccess: !!res.unrestrictedUnidentifiedAccess,
  };

  if (hasKey) {
    if (typeof res.name === 'string' && res.name) {
      try {
        Object.assign(out, await decryptProfileName(res.name, profileKey!));
      } catch {
        // stale profile key
      }
    }
    if (typeof res.about === 'string' && res.about) {
      try {
        out.about = untilNul(await decryptProfile(fromBase64(res.about), profileKey!));
      } catch {
        // stale profile key
      }
    }
    if (typeof res.aboutEmoji === 'string' && res.aboutEmoji) {
      try {
        out.aboutEmoji = untilNul(await decryptProfile(fromBase64(res.aboutEmoji), profileKey!));
      } catch {
        // stale profile key
      }
    }
  }

  if (typeof res.identityKey === 'string') {
    try {
      out.identityKey = fromBase64(res.identityKey);
      await store.saveIdentity(aci, out.identityKey, { uuid: aci });
    } catch {
      // malformed identity key
    }
  }
  return out;
}

/** Download a profile avatar from CDN 0 and decrypt it with the owner's profile key. */
export async function downloadAndDecryptProfileAvatar(
  httpBinary: SignalHttpBinaryFn,
  avatarUrlPath: string,
  profileKey: Uint8Array,
  cdnUrl = DEFAULT_SIGNAL_CDN
): Promise<Uint8Array> {
  const cleanPath = avatarUrlPath.replace(/^\/+/, '');
  const encrypted = await httpBinary('GET', `${cdnUrl}/${cleanPath}`, null, {}, 20000);
  return decryptProfile(encrypted, profileKey);
}

/**
 * Write our profile with `PUT /v1/profile` like Signal-Desktop: version and commitment from zkgroup, padded encrypted fields, and the existing avatar kept (`avatar: false, sameAvatar: true`). Fields not in `patch` are carried over from the current profile so a name change doesn't clear the about text.
 */
export async function uploadOwnProfile(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  patch: { name: string; about?: string; emoji?: string },
  serverUrl = DEFAULT_SIGNAL_SERVER
): Promise<void> {
  const acc = await store.getAccount();
  if (!acc || !acc.profileKey || acc.profileKey.length !== 32) return;
  const key = acc.profileKey;

  let current: DecryptedProfile | null = null;
  try {
    current = await fetchAndDecryptProfile(store, httpJson, acc.aci, key, serverUrl);
  } catch {
    // no profile yet
  }

  const parts = (patch.name || '').trim().split(/\s+/);
  const givenName = parts[0] || patch.name;
  const familyName = parts.slice(1).join(' ');
  const about = patch.about !== undefined ? patch.about : current ? current.about : '';
  const emoji = patch.emoji !== undefined ? patch.emoji : current ? current.aboutEmoji : '';

  const body = {
    version: libsignal.profileKeyGetVersion(key, acc.aci),
    name: await encryptProfileName(givenName, familyName, key),
    about: about ? toBase64(await encryptPadded(new TextEncoder().encode(about), key, PADDED_LENGTHS.about)) : null,
    aboutEmoji: emoji ? toBase64(await encryptPadded(new TextEncoder().encode(emoji), key, PADDED_LENGTHS.aboutEmoji)) : null,
    badgeIds: [],
    paymentAddress: null,
    avatar: false,
    sameAvatar: true,
    commitment: toBase64(libsignal.profileKeyGetCommitment(key, acc.aci)),
    phoneNumberSharing: (current && current.phoneNumberSharing) || toBase64(await encryptProfile(new Uint8Array([0]), key)),
  };

  await httpJson('PUT', '/v1/profile', body, {
    baseUrl: serverUrl,
    basicAuth: { username: `${acc.aci}.${acc.deviceId}`, password: acc.password },
    timeout: 15000,
  });
}

function toWebSafeBase64(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Resolve a Signal username (`@alice.42` or `alice.42`) to an ACI via `GET /v1/accounts/username_hash/{hash}`, hashing with libsignal's username hash.
 */
export async function resolveSignalUsername(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  rawUsername: string,
  serverUrl = DEFAULT_SIGNAL_SERVER
): Promise<{ uuid: string; username: string } | null> {
  const clean = rawUsername.trim().replace(/^@/, '');
  if (!clean) return null;

  let hash: Uint8Array;
  try {
    hash = libsignal.usernameHash(clean);
  } catch {
    return null;
  }

  const acc = await store.getAccount();
  const auth = acc ? { username: `${acc.aci}.${acc.deviceId}`, password: acc.password } : undefined;
  try {
    const res = await httpJson('GET', `/v1/accounts/username_hash/${toWebSafeBase64(hash)}`, null, {
      baseUrl: serverUrl,
      basicAuth: auth,
      noAuth: !auth,
      timeout: 10000,
    });
    if (res && typeof res.uuid === 'string') return { uuid: res.uuid, username: clean };
  } catch {
    // not found
  }
  return null;
}
