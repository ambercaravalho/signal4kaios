/* Shape checks for identifiers and fields that arrive from the network, storage, or another device. */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a bare UUID; a PNI's `PNI:` prefix doesn't match. */
export function isUuid(id: string): boolean {
  return UUID_RE.test(id);
}

export const E164_RE = /^\+[1-9][0-9]{6,14}$/;

/** A blurhash string: the base83 alphabet, no longer than Signal's clients send. */
export const BLURHASH_RE = /^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]{6,120}$/;

export function isBlurHash(s: unknown): s is string {
  return typeof s === 'string' && BLURHASH_RE.test(s);
}

/** A stable release version, `major.minor.patch`; pre-releases never count as updates. */
export const RELEASE_VERSION_RE = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;

export function isReleaseVersion(s: unknown): s is string {
  return typeof s === 'string' && RELEASE_VERSION_RE.test(s);
}

export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export function isSha256Hex(s: unknown): s is string {
  return typeof s === 'string' && SHA256_HEX_RE.test(s);
}
