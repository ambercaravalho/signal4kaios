/* Signal profiles, profile avatars, and username lookup. The profile cipher, padding, and request bodies follow Signal-Desktop (Crypto.node.ts, encryptProfileData.preload.ts, WebAPI getProfile/putProfile); profile key versions, commitments, access keys, and username hashes come from libsignal (zkgroup, usernames). */

import { fromBase64, randomBytes, toBase64, toHex, toWebSafeBase64 } from '../bytes';
import { openGcm, sealGcm } from '../crypto/primitives';
import { libsignal } from '../protocol/libsignal';
import type { SignalProtocolStore } from '../protocol/store';
import { accountBasicAuth, DEFAULT_SIGNAL_CDN, DEFAULT_SIGNAL_SERVER, SignalHttpBinaryFn, SignalHttpJsonFn } from '../net/http';

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

async function encryptProfile(data: Uint8Array, profileKey: Uint8Array): Promise<Uint8Array> {
  if (profileKey.length !== 32) throw new Error('Got invalid length profile key');
  return sealGcm(profileKey, data);
}

export async function decryptProfile(data: Uint8Array, profileKey: Uint8Array): Promise<Uint8Array> {
  if (profileKey.length !== 32) throw new Error('Got invalid length profile key');
  return openGcm(profileKey, data, 1);
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
    basicAuth: accountBasicAuth(acc),
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

interface StoredProfileKeyCredential {
  profileKey: string;
  credential: string;
  expiresAtSeconds: number;
}

/**
 * A member's expiring profile key credential, needed to add them to a group: `GET /v1/profile/{aci}/{version}/{hex(request)}?credentialType=expiringProfileKey` like Signal-Desktop's getProfile with a credential request, verified and received by zkgroup, and cached until a day before it expires.
 */
export async function fetchExpiringProfileKeyCredential(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  serverPublicParams: Uint8Array,
  aci: string,
  profileKey: Uint8Array,
  serverUrl = DEFAULT_SIGNAL_SERVER
): Promise<Uint8Array> {
  if (profileKey.length !== 32) throw new Error('Got invalid length profile key');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cache = ((await store.loadValue('profileKeyCredentials')) as Record<string, StoredProfileKeyCredential> | undefined) || {};
  const hit = cache[aci];
  if (hit && hit.profileKey === toBase64(profileKey) && hit.expiresAtSeconds - 86400 > nowSeconds) return fromBase64(hit.credential);

  const acc = await store.getAccount();
  if (!acc) throw new Error('This phone is not linked to a Signal account');
  const req = libsignal.profileKeyCredentialRequest(serverPublicParams, aci, profileKey) as { context: Uint8Array; request: Uint8Array };
  const version = libsignal.profileKeyGetVersion(profileKey, aci);
  // SECURITY-REVIEW: device password is sent only as Basic auth to the Signal chat server.
  const res = await httpJson('GET', `/v1/profile/${encodeURIComponent(aci)}/${version}/${toHex(req.request)}?credentialType=expiringProfileKey`, null, {
    baseUrl: serverUrl,
    basicAuth: accountBasicAuth(acc),
    timeout: 15000,
  });
  if (!res || typeof res.credential !== 'string') throw new Error('Signal server returned no profile key credential');
  const received = libsignal.receiveExpiringProfileKeyCredential(serverPublicParams, req.context, fromBase64(res.credential), nowSeconds) as {
    credential: Uint8Array;
    expiresAtSeconds: number;
  };
  for (const k of Object.keys(cache)) if (cache[k].expiresAtSeconds <= nowSeconds) delete cache[k];
  cache[aci] = { profileKey: toBase64(profileKey), credential: toBase64(received.credential), expiresAtSeconds: received.expiresAtSeconds };
  await store.storeValue('profileKeyCredentials', cache);
  return received.credential;
}

/**
 * Take on the profile key the primary phone wrote to `AccountRecord.profileKey`, as Signal-Desktop's `mergeAccountRecord` does: the phone rotates it (after a block, for instance) and linked devices follow. Our cached credential for the old key is dropped. Returns whether the key changed.
 */
export async function adoptOwnProfileKey(store: SignalProtocolStore, profileKey: Uint8Array | undefined): Promise<boolean> {
  if (!profileKey || profileKey.length !== 32) return false;
  const acc = await store.getAccount();
  if (!acc || (acc.profileKey && toBase64(acc.profileKey) === toBase64(profileKey))) return false;
  // SECURITY-REVIEW: the profile key is account key material; it's saved only in the protocol store and never logged.
  await store.saveAccount({ ...acc, profileKey: new Uint8Array(profileKey) });
  const cache = (await store.loadValue('profileKeyCredentials')) as Record<string, StoredProfileKeyCredential> | undefined;
  if (cache && cache[acc.aci]) {
    delete cache[acc.aci];
    await store.storeValue('profileKeyCredentials', cache);
  }
  return true;
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

/** The S3 POST form `PUT /v1/profile` returns for a new avatar (Signal-Server `ProfileAvatarUploadAttributes`). */
export interface ProfileAvatarForm {
  key: string;
  credential: string;
  acl: string;
  algorithm: string;
  date: string;
  policy: string;
  signature: string;
}

const FORM_FIELDS = ['key', 'credential', 'acl', 'algorithm', 'date', 'policy', 'signature'] as const;

/** The server's upload form, or an error: every field must be present, and since each lands inside the multipart body, only printable ASCII without spaces is accepted. */
function parseAvatarForm(res: unknown): ProfileAvatarForm {
  if (!res || typeof res !== 'object') throw new Error('Signal server returned no avatar upload form');
  const raw = res as Record<string, unknown>;
  const out = {} as ProfileAvatarForm;
  for (const f of FORM_FIELDS) {
    const v = raw[f];
    if (typeof v !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(v)) throw new Error(`Avatar upload form has a bad ${f}`);
    out[f] = v;
  }
  if (!/^[A-Za-z0-9_\-/.=+]{1,256}$/.test(out.key) || out.key.indexOf('..') >= 0 || out.key[0] === '/') throw new Error('Avatar upload form has a bad key');
  return out;
}

/** Signal-Desktop's `makePutParams`: the form fields in its order, then the encrypted avatar as `file`. */
export function avatarUploadBody(form: ProfileAvatarForm, encrypted: Uint8Array, boundaryId = toHex(randomBytes(16))): { body: Uint8Array; contentType: string } {
  const boundary = `----------------${boundaryId}`;
  const CRLF = '\r\n';
  const section = (name: string, value: string) => [`--${boundary}`, `Content-Disposition: form-data; name="${name}"${CRLF}`, value].join(CRLF);
  const start = [
    section('key', form.key),
    section('x-amz-credential', form.credential),
    section('acl', form.acl),
    section('x-amz-algorithm', form.algorithm),
    section('x-amz-date', form.date),
    section('policy', form.policy),
    section('x-amz-signature', form.signature),
    section('Content-Type', 'application/octet-stream'),
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"',
    `Content-Type: application/octet-stream${CRLF}${CRLF}`,
  ].join(CRLF);
  const head = new TextEncoder().encode(start);
  const tail = new TextEncoder().encode(`${CRLF}--${boundary}--${CRLF}`);
  const body = new Uint8Array(head.length + encrypted.length + tail.length);
  body.set(head);
  body.set(encrypted, head.length);
  body.set(tail, head.length + encrypted.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** POST an encrypted avatar to CDN 0 with the server's form; resolves to the avatar's path. */
async function uploadProfileAvatar(httpBinary: SignalHttpBinaryFn, form: ProfileAvatarForm, encrypted: Uint8Array, cdnUrl = DEFAULT_SIGNAL_CDN): Promise<string> {
  const { body, contentType } = avatarUploadBody(form, encrypted);
  await httpBinary('POST', `${cdnUrl}/`, body, { 'Content-Type': contentType }, 60000);
  return form.key;
}

/** What a profile write did to the avatar: `avatarUrlPath` is the new path, null when the avatar was removed, and absent when it was kept. */
export interface OwnProfileWrite {
  avatarUrlPath?: string | null;
}

/**
 * Write our profile with `PUT /v1/profile` like Signal-Desktop: version and commitment from zkgroup, and padded encrypted fields. Fields not in `patch` are carried over from the current profile so a name change doesn't clear the about text; with no name in either, nothing is written and the result is null.
 *
 * `patch.avatar` uploads new avatar bytes (encrypted unpadded, as Desktop does) through `upload`, or with null removes the avatar; left out, the avatar is kept.
 */
export async function uploadOwnProfile(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  patch: { name?: string; about?: string; emoji?: string; sharePhoneNumber: boolean; avatar?: Uint8Array | null },
  serverUrl = DEFAULT_SIGNAL_SERVER,
  upload?: { httpBinary: SignalHttpBinaryFn; cdnUrl?: string }
): Promise<OwnProfileWrite | null> {
  const acc = await store.getAccount();
  if (!acc || !acc.profileKey || acc.profileKey.length !== 32) return null;
  if (patch.avatar && !upload) throw new Error('An avatar upload needs the CDN client');
  const key = acc.profileKey;

  let current: DecryptedProfile | null = null;
  try {
    current = await fetchAndDecryptProfile(store, httpJson, acc.aci, key, serverUrl);
  } catch {
    // no profile yet
  }

  let givenName: string;
  let familyName: string;
  if (patch.name && patch.name.trim()) {
    const parts = patch.name.trim().split(/\s+/);
    givenName = parts[0];
    familyName = parts.slice(1).join(' ');
  } else if (current && current.givenName) {
    givenName = current.givenName;
    familyName = current.familyName;
  } else {
    return null;
  }
  const about = patch.about !== undefined ? patch.about : current ? current.about : '';
  const emoji = patch.emoji !== undefined ? patch.emoji : current ? current.aboutEmoji : '';

  const body = {
    version: libsignal.profileKeyGetVersion(key, acc.aci),
    name: await encryptProfileName(givenName, familyName, key),
    about: about ? toBase64(await encryptPadded(new TextEncoder().encode(about), key, PADDED_LENGTHS.about)) : null,
    aboutEmoji: emoji ? toBase64(await encryptPadded(new TextEncoder().encode(emoji), key, PADDED_LENGTHS.aboutEmoji)) : null,
    badgeIds: [],
    paymentAddress: null,
    // Signal's server reads `avatar: false` as removing the avatar whatever `sameAvatar` says, so keeping it sends `avatar: true, sameAvatar: true`.
    avatar: patch.avatar !== null,
    sameAvatar: patch.avatar === undefined,
    commitment: toBase64(libsignal.profileKeyGetCommitment(key, acc.aci)),
    phoneNumberSharing: toBase64(await encryptProfile(new Uint8Array([patch.sharePhoneNumber ? 1 : 0]), key)),
  };

  // SECURITY-REVIEW: device password is sent only as Basic auth to the Signal chat server.
  const res = await httpJson('PUT', '/v1/profile', body, {
    baseUrl: serverUrl,
    basicAuth: accountBasicAuth(acc),
    timeout: 15000,
  });
  if (patch.avatar === undefined) return {};
  if (patch.avatar === null) return { avatarUrlPath: null };
  const form = parseAvatarForm(res);
  const encrypted = await encryptProfile(patch.avatar, key);
  return { avatarUrlPath: await uploadProfileAvatar(upload!.httpBinary, form, encrypted, upload!.cdnUrl) };
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
  const auth = acc ? accountBasicAuth(acc) : undefined;
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
