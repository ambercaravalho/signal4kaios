/* Encrypted Signal Profiles, CDN Profile Avatars, and Username Discovery.
 *
 * Implements:
 * 1. `fetchAndDecryptProfile`: `GET /v1/profile/{uuid}` -> decrypts AES-256-GCM `name`, `about`, `aboutEmoji`
 *    using the contact's 32-byte `ProfileKey`.
 * 2. `downloadAndDecryptProfileAvatar`: downloads encrypted avatar from Signal CDN (`https://cdn.signal.org/{avatarUrlPath}`)
 *    and decrypts it using AES-256-GCM with the contact's `ProfileKey`.
 * 3. `uploadOwnProfile`: encrypts our own `name` and `about` with our `AccountCredentials.profileKey`
 *    and uploads via `PUT /v1/profile`.
 * 4. `resolveSignalUsername`: resolves a Signal username (`@alice.01` or `https://signal.me/#eu/...`)
 *    via `GET /v1/accounts/username_hash/{hash}` or `/v1/accounts/username_link/{uuid}`.
 */

import { fromBase64, toBase64 } from './bytes';
import {
  decryptProfileField,
  encryptProfileField,
} from './crypto/attachment';
import { hashSha256 } from './crypto/primitives';
import type { SignalHttpJsonFn } from './provisioning';
import type { SignalProtocolStore } from './storage';
import { DEFAULT_SIGNAL_CDN, DEFAULT_SIGNAL_SERVER, SignalHttpBinaryFn } from './transport';

export interface DecryptedProfile {
  uuid: string;
  identityKey?: Uint8Array;
  givenName: string;
  familyName: string;
  fullName: string;
  about: string;
  aboutEmoji: string;
  avatarUrlPath?: string;
  unidentifiedAccess?: string;
  unrestrictedUnidentifiedAccess?: boolean;
}

function unpadProfileString(padded: Uint8Array): string {
  let end = padded.length;
  for (let i = 0; i < padded.length; i++) {
    if (padded[i] === 0x00) {
      end = i;
      break;
    }
  }
  return new TextDecoder().decode(padded.slice(0, end));
}

/**
 * Decrypt a Signal profile `name` field (which separates givenName and familyName by a 0x00 byte).
 */
export async function decryptProfileName(
  encryptedB64: string,
  profileKey32: Uint8Array
): Promise<{ givenName: string; familyName: string; fullName: string }> {
  const padded = await decryptProfileField(fromBase64(encryptedB64), profileKey32);
  const firstNull = padded.indexOf(0x00);
  if (firstNull < 0) {
    const given = new TextDecoder().decode(padded).trim();
    return { givenName: given, familyName: '', fullName: given };
  }
  const givenName = new TextDecoder().decode(padded.slice(0, firstNull)).trim();
  const rest = padded.slice(firstNull + 1);
  const secondNull = rest.indexOf(0x00);
  const familyBytes = secondNull >= 0 ? rest.slice(0, secondNull) : rest;
  const familyName = new TextDecoder().decode(familyBytes).trim();
  const fullName = [givenName, familyName].filter(Boolean).join(' ');
  return { givenName, familyName, fullName };
}

/**
 * Encrypt a Signal profile `name` field (givenName + optional `\0` + familyName, padded to standard 53/257 bytes).
 */
export async function encryptProfileName(
  givenName: string,
  familyName: string,
  profileKey32: Uint8Array
): Promise<string> {
  const gBytes = new TextEncoder().encode(givenName.trim());
  const fBytes = new TextEncoder().encode((familyName || '').trim());
  const combined = new Uint8Array(gBytes.length + (fBytes.length > 0 ? 1 + fBytes.length : 0));
  combined.set(gBytes, 0);
  if (fBytes.length > 0) {
    combined[gBytes.length] = 0x00;
    combined.set(fBytes, gBytes.length + 1);
  }
  const padTarget = combined.length <= 53 ? 53 : 257;
  const encrypted = await encryptProfileField(combined, profileKey32, padTarget);
  return toBase64(encrypted);
}

/**
 * Fetch and decrypt a contact's Signal profile using `GET /v1/profile/{uuid}`.
 */
export async function fetchAndDecryptProfile(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  uuid: string,
  profileKey32?: Uint8Array,
  serverUrl = DEFAULT_SIGNAL_SERVER
): Promise<DecryptedProfile | null> {
  const acc = await store.getAccount();
  if (!acc) return null;

  const res = await httpJson(
    'GET',
    `/v1/profile/${encodeURIComponent(uuid)}`,
    null,
    {
      baseUrl: serverUrl,
      basicAuth: { username: `${acc.aci}.${acc.deviceId}`, password: acc.password },
      timeout: 15000,
    }
  );
  if (!res) return null;

  let givenName = '';
  let familyName = '';
  let fullName = '';
  let about = '';
  let aboutEmoji = '';

  if (profileKey32 && profileKey32.length === 32) {
    if (res.name) {
      try {
        const nm = await decryptProfileName(res.name, profileKey32);
        givenName = nm.givenName;
        familyName = nm.familyName;
        fullName = nm.fullName;
      } catch {
        // Ignore name decryption failure if key is outdated
      }
    }
    if (res.about) {
      try {
        const ab = await decryptProfileField(fromBase64(res.about), profileKey32);
        about = unpadProfileString(ab);
      } catch {
        // Ignore
      }
    }
    if (res.aboutEmoji) {
      try {
        const em = await decryptProfileField(fromBase64(res.aboutEmoji), profileKey32);
        aboutEmoji = unpadProfileString(em);
      } catch {
        // Ignore
      }
    }
  }

  if (res.identityKey) {
    try {
      await store.saveIdentity(uuid, fromBase64(res.identityKey), { uuid });
    } catch {
      // Ignore
    }
  }

  return {
    uuid,
    identityKey: res.identityKey ? fromBase64(res.identityKey) : undefined,
    givenName,
    familyName,
    fullName,
    about,
    aboutEmoji,
    avatarUrlPath: res.avatar || undefined,
    unidentifiedAccess: res.unidentifiedAccess,
    unrestrictedUnidentifiedAccess: !!res.unrestrictedUnidentifiedAccess,
  };
}

/**
 * Download and decrypt a contact's profile avatar from Signal CDN using their 32-byte `ProfileKey`.
 */
export async function downloadAndDecryptProfileAvatar(
  httpBinary: SignalHttpBinaryFn,
  avatarUrlPath: string,
  profileKey32: Uint8Array,
  cdnUrl = DEFAULT_SIGNAL_CDN
): Promise<Uint8Array> {
  const cleanPath = avatarUrlPath.replace(/^\/+/, '');
  const encrypted = await httpBinary(
    'GET',
    `${cdnUrl}/${cleanPath}`,
    null,
    {},
    20000
  );
  return decryptProfileField(encrypted, profileKey32);
}

/**
 * Encrypt and upload our own Signal profile (`name`, `about`, `aboutEmoji`).
 */
export async function uploadOwnProfile(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  patch: { name: string; about?: string; emoji?: string },
  serverUrl = DEFAULT_SIGNAL_SERVER
): Promise<void> {
  const acc = await store.getAccount();
  if (!acc || !acc.profileKey || acc.profileKey.length !== 32) {
    return;
  }

  const parts = (patch.name || '').trim().split(/\s+/);
  const givenName = parts[0] || patch.name;
  const familyName = parts.slice(1).join(' ');

  const encryptedName = await encryptProfileName(
    givenName,
    familyName,
    acc.profileKey
  );

  const body: Record<string, unknown> = {
    name: encryptedName,
  };

  if (patch.about !== undefined) {
    const aboutBytes = new TextEncoder().encode(patch.about);
    const padLen = aboutBytes.length <= 128 ? 128 : 512;
    const encAbout = await encryptProfileField(aboutBytes, acc.profileKey, padLen);
    body.about = toBase64(encAbout);
  }

  if (patch.emoji !== undefined) {
    const emojiBytes = new TextEncoder().encode(patch.emoji);
    const encEmoji = await encryptProfileField(emojiBytes, acc.profileKey, 32);
    body.aboutEmoji = toBase64(encEmoji);
  }

  await httpJson('PUT', '/v1/profile', body, {
    baseUrl: serverUrl,
    basicAuth: { username: `${acc.aci}.${acc.deviceId}`, password: acc.password },
    timeout: 15000,
  });
}

/**
 * Resolve a Signal username (`@alice.42` or `alice.42`) to a Signal `ACI` (UUID) via Signal server.
 */
export async function resolveSignalUsername(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  rawUsername: string,
  serverUrl = DEFAULT_SIGNAL_SERVER
): Promise<{ uuid: string; username: string } | null> {
  const clean = rawUsername.trim().replace(/^@/, '').toLowerCase();
  if (!clean) return null;

  const acc = await store.getAccount();
  const auth = acc
    ? { username: `${acc.aci}.${acc.deviceId}`, password: acc.password }
    : undefined;

  // Compute URL-safe base64 SHA-256 username hash
  const digest = hashSha256(new TextEncoder().encode(clean));
  const b64Url = toBase64(digest)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  try {
    const res = await httpJson(
      'GET',
      `/v1/accounts/username_hash/${encodeURIComponent(b64Url)}`,
      null,
      {
        baseUrl: serverUrl,
        basicAuth: auth,
        noAuth: !auth,
        timeout: 10000,
      }
    );
    if (res && res.uuid) {
      return { uuid: res.uuid, username: clean };
    }
  } catch {
    // Fallback if server rejects hash format or username not found
  }
  return null;
}
