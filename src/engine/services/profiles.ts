/* Signal profiles and username lookup; the cipher is in `./profile-crypto` and avatars in `./profile-avatar`. Request bodies follow Signal-Desktop's WebAPI getProfile/putProfile; profile key versions, commitments, and username hashes come from libsignal (zkgroup, usernames). */

import { fromBase64, toBase64, toHex, toWebSafeBase64 } from '../bytes';
import { libsignal } from '../protocol/libsignal';
import type { SignalProtocolStore } from '../protocol/store';
import { accountBasicAuth, asObject, DEFAULT_SIGNAL_SERVER, SignalHttpBinaryFn, SignalHttpJsonFn } from '../net/http';
import { parseAvatarForm, uploadProfileAvatar } from './profile-avatar';
import { decryptProfile, decryptProfileName, encryptPadded, encryptProfile, encryptProfileName, PADDED_LENGTHS, untilNul } from './profile-crypto';

export { avatarUploadBody, downloadAndDecryptProfileAvatar } from './profile-avatar';
export { decryptProfile, decryptProfileName, encryptProfileName } from './profile-crypto';

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

  const res = asObject(await httpJson('GET', path, null, {
    baseUrl: serverUrl,
    basicAuth: accountBasicAuth(acc),
    timeout: 15000,
  }));
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
    unidentifiedAccess: typeof res.unidentifiedAccess === 'string' ? res.unidentifiedAccess : undefined,
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
  const res = asObject(await httpJson('GET', `/v1/profile/${encodeURIComponent(aci)}/${version}/${toHex(req.request)}?credentialType=expiringProfileKey`, null, {
    baseUrl: serverUrl,
    basicAuth: accountBasicAuth(acc),
    timeout: 15000,
  }));
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
  const res = asObject(await httpJson('PUT', '/v1/profile', body, {
    baseUrl: serverUrl,
    basicAuth: accountBasicAuth(acc),
    timeout: 15000,
  }));
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
    const res = asObject(await httpJson('GET', `/v1/accounts/username_hash/${toWebSafeBase64(hash)}`, null, {
      baseUrl: serverUrl,
      basicAuth: auth,
      noAuth: !auth,
      timeout: 10000,
    }));
    if (res && typeof res.uuid === 'string') return { uuid: res.uuid, username: clean };
  } catch {
    // not found
  }
  return null;
}
