/* Signal usernames: reserve, confirm, and delete on the chat server, plus the encrypted username link. The flow follows Signal-Desktop (services/username.ts, WebAPI reserveUsername/confirmUsername/deleteUsername); candidates, hashes, proofs, and link encryption come from libsignal. */

import { fromBase64, toWebSafeBase64, uuidToBytes } from '../bytes';
import { libsignal } from '../protocol/libsignal';
import type { SignalProtocolStore } from '../protocol/store';
import { accountBasicAuth, DEFAULT_SIGNAL_SERVER, SignalHttpJsonFn } from '../net/http';

type UsernameErrorCode =
  | 'UsernameInvalid'
  | 'UsernameUnavailable'
  | 'UsernameReservationLost'
  | 'UsernameRateLimited'
  | 'UsernameLinkFailed';

class UsernameServiceError extends Error {
  readonly code: UsernameErrorCode;

  constructor(code: UsernameErrorCode, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

export interface ConfirmedUsername {
  username: string;
  /** 32-byte key of the username link; keep it so a later username change keeps the same QR code key. */
  entropy: Uint8Array;
  /** Server handle (UUID) of the encrypted username behind the link. */
  serverId: string;
}

const NICKNAME_MESSAGES: Record<string, string> = {
  NicknameCannotBeEmpty: 'Enter a username',
  NicknameTooShort: 'Usernames need at least 3 characters',
  NicknameTooLong: 'Usernames can have at most 32 characters',
  NicknameCannotStartWithDigit: "Usernames can't start with a number",
  BadNicknameCharacter: 'Usernames can only use a-z, 0-9 and _',
  MissingSeparator: 'Usernames need a dot before the number',
  DiscriminatorCannotBeEmpty: 'Add a number after the dot',
  DiscriminatorCannotBeZero: "The number after the dot can't be 0",
  DiscriminatorCannotBeSingleDigit: 'The number after the dot needs 2 or more digits',
  DiscriminatorCannotHaveLeadingZeros: "The number after the dot can't start with 00",
  BadDiscriminatorCharacter: 'The part after the dot must be a number',
  DiscriminatorTooLarge: 'The number after the dot is too large',
};

function invalid(e: any): UsernameServiceError {
  const variant = e && e.name === 'UsernameError' ? String(e.message) : '';
  return new UsernameServiceError('UsernameInvalid', NICKNAME_MESSAGES[variant] || 'That username is not valid');
}

/** Usernames to try: the exact `nickname.42` when the user typed a number, otherwise libsignal's random candidates. */
export function usernameCandidates(input: string): string[] {
  const clean = input.trim().replace(/^@/, '');
  try {
    if (clean.indexOf('.') >= 0) {
      libsignal.usernameHash(clean);
      return [clean];
    }
    return libsignal.usernameCandidates(clean) as string[];
  } catch (e) {
    throw invalid(e);
  }
}

/** `https://signal.me/#eu/…` link to share as a QR code, built like Signal-Desktop's getUsernameLinkUrl. */
export function usernameLinkUrl(entropy: Uint8Array, serverId: Uint8Array): string {
  const bytes = new Uint8Array(entropy.length + serverId.length);
  bytes.set(entropy, 0);
  bytes.set(serverId, entropy.length);
  return 'https://signal.me/#eu/' + toWebSafeBase64(bytes);
}

function httpError(err: any, conflict: UsernameServiceError): UsernameServiceError | null {
  const status = err && err.status;
  if (status === 409 || status === 410) return conflict;
  if (status === 422) return new UsernameServiceError('UsernameInvalid', 'That username is not valid');
  if (status === 413 || status === 429) return new UsernameServiceError('UsernameRateLimited', 'Too many tries; wait a while and try again');
  return null;
}

/**
 * Reserve one of the candidates for `input`, then confirm it with a proof and a fresh encrypted username link. Pass the current link entropy to keep the link key across username changes.
 */
export async function setUsername(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  input: string,
  serverUrl = DEFAULT_SIGNAL_SERVER,
  previousEntropy?: Uint8Array
): Promise<ConfirmedUsername> {
  const acc = await store.getAccount();
  if (!acc) throw new Error('Not linked');
  // SECURITY-REVIEW: device credentials authenticate the reserve/confirm calls; never log them.
  const opts = { baseUrl: serverUrl, basicAuth: accountBasicAuth(acc), timeout: 15000 };

  const candidates = usernameCandidates(input);
  const hashes = candidates.map((c) => toWebSafeBase64(libsignal.usernameHash(c)));

  let reserved: any;
  try {
    reserved = await httpJson('PUT', '/v1/accounts/username_hash/reserve', { usernameHashes: hashes }, opts);
  } catch (e: any) {
    throw httpError(e, new UsernameServiceError('UsernameUnavailable', 'That username is taken')) || e;
  }
  const reservedHash = reserved && typeof reserved.usernameHash === 'string' ? toWebSafeBase64(fromBase64(reserved.usernameHash)) : '';
  const index = hashes.indexOf(reservedHash);
  if (index < 0) throw new Error('Server reserved a username we did not ask for');
  const username = candidates[index];

  const proof = libsignal.usernameProof(username);
  let link: { entropy: Uint8Array; encryptedUsername: Uint8Array };
  try {
    link = libsignal.usernameLinkCreate(username, previousEntropy && previousEntropy.length === 32 ? previousEntropy : undefined);
  } catch {
    throw new UsernameServiceError('UsernameLinkFailed', 'Could not create the username link');
  }

  let confirmed: any;
  try {
    confirmed = await httpJson(
      'PUT',
      '/v1/accounts/username_hash/confirm',
      { usernameHash: reservedHash, zkProof: toWebSafeBase64(proof), encryptedUsername: toWebSafeBase64(link.encryptedUsername) },
      opts
    );
  } catch (e: any) {
    throw httpError(e, new UsernameServiceError('UsernameReservationLost', 'That username was taken while saving; try again')) || e;
  }
  const handle = confirmed && typeof confirmed.usernameLinkHandle === 'string' ? confirmed.usernameLinkHandle : '';
  try {
    uuidToBytes(handle);
  } catch {
    throw new UsernameServiceError('UsernameLinkFailed', 'Server returned no username link');
  }
  return { username, entropy: link.entropy, serverId: handle };
}

export async function deleteUsername(store: SignalProtocolStore, httpJson: SignalHttpJsonFn, serverUrl = DEFAULT_SIGNAL_SERVER): Promise<void> {
  const acc = await store.getAccount();
  if (!acc) throw new Error('Not linked');
  // SECURITY-REVIEW: device credentials authenticate the delete call; never log them.
  await httpJson('DELETE', '/v1/accounts/username_hash', null, {
    baseUrl: serverUrl,
    basicAuth: accountBasicAuth(acc),
    timeout: 15000,
  });
}
