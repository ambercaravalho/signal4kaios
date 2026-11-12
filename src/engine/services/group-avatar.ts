/* Group photos on CDN 0, like Signal-Desktop's `decryptGroupAvatar` (ts/groups.preload.ts): the encrypted `GroupAttributeBlob` at the key `Group.avatarUrl` names, decrypted with the group's secret params. */

import { DEFAULT_SIGNAL_CDN, SignalHttpBinaryFn } from '../net/http';
import { decryptAttribute } from './groups-v2';

/** Signal's storage server names group avatars `groups/<group identifier>/<random bytes>`, each in unpadded base64url. */
const GROUP_AVATAR_KEY = /^groups(\/[A-Za-z0-9_-]{1,64}){1,2}$/;

export function isGroupAvatarKey(key: string): boolean {
  return GROUP_AVATAR_KEY.test(key);
}

/** Download a group's photo and decrypt it; throws when the key, the download, or the blob isn't a group avatar. */
export async function downloadAndDecryptGroupAvatar(
  httpBinary: SignalHttpBinaryFn,
  key: string,
  secretParams: Uint8Array,
  cdnUrl = DEFAULT_SIGNAL_CDN
): Promise<Uint8Array> {
  if (!isGroupAvatarKey(key)) throw new Error('Not a group avatar key');
  const encrypted = await httpBinary('GET', `${cdnUrl}/${key}`, null, {}, 20000);
  const content = decryptAttribute(secretParams, encrypted);
  if (!content || content.case !== 'avatar' || !content.value.length) throw new Error('The group avatar could not be decrypted');
  return content.value;
}
