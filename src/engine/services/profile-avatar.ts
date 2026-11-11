/* Profile avatars on CDN 0: download and decrypt, and the S3 form upload Signal-Desktop's `makePutParams` builds. */

import { randomBytes, toHex } from '../bytes';
import { DEFAULT_SIGNAL_CDN, SignalHttpBinaryFn } from '../net/http';
import { decryptProfile } from './profile-crypto';

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
export function parseAvatarForm(res: unknown): ProfileAvatarForm {
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
export async function uploadProfileAvatar(httpBinary: SignalHttpBinaryFn, form: ProfileAvatarForm, encrypted: Uint8Array, cdnUrl = DEFAULT_SIGNAL_CDN): Promise<string> {
  const { body, contentType } = avatarUploadBody(form, encrypted);
  await httpBinary('POST', `${cdnUrl}/`, body, { 'Content-Type': contentType }, 60000);
  return form.key;
}
