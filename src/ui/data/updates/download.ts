/* Downloads a release's ZIP, checks it against `update.json`, and saves it where the phone's install service and OStore can read it. */

import { toHex } from '../../../engine/bytes';
import { hashSha256 } from '../../../engine/crypto/primitives';
import { http } from '../http';
import { dbg } from '../log';
import { saveToDevicePath } from '../platform';
import { RELEASES_URL, type UpdateInfo } from './check';

/** Phone storage the update is saved to. `device-storage:sdcard` is create-only, so an existing file is never replaced. */
const STORAGE = 'sdcard';
const MAX_NAME_TRIES = 5;

export interface SavedUpdate {
  /** The file name the user picks in OStore. */
  name: string;
  /** Its absolute path, for the install service. */
  path: string;
}

function updateError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

export function zipUrl(info: UpdateInfo): string {
  return RELEASES_URL + '/download/' + info.tag + '/' + info.zip;
}

/** SECURITY-REVIEW: the downloaded ZIP is installed over Beacon, so it must match the size and SHA-256 that the release's `update.json` lists before it's saved. */
export function verifyZip(bytes: Uint8Array, info: UpdateInfo): boolean {
  return bytes.length === info.size && toHex(hashSha256(bytes)) === info.sha256;
}

/** Download the release's ZIP; `onProgress` gets the fraction done. Rejects with `UpdateCorrupt` when it doesn't match. */
export function downloadUpdate(info: UpdateInfo, onProgress?: (fraction: number) => void): Promise<Uint8Array> {
  return http.external('GET', zipUrl(info), { maxBytes: info.size, timeout: 30000, onProgress: onProgress && ((loaded) => onProgress(Math.min(1, loaded / info.size))) }).then(
    (bytes) => {
      if (!verifyZip(bytes, info)) {
        dbg('update: downloaded ' + bytes.length + ' bytes that do not match update.json');
        throw updateError('UpdateCorrupt', 'update does not match its checksum');
      }
      return bytes;
    },
    (e: { kind?: string; message?: string }) => {
      dbg('update: download failed ' + (e && e.kind) + ' ' + (e && e.message));
      throw e && e.kind === 'http' ? updateError('UpdateUnavailable', 'update download failed') : e;
    }
  );
}

/** `signal4kaios-2.11.0.zip`, then `signal4kaios-2.11.0-2.zip`, ... */
export function candidateName(info: UpdateInfo, attempt: number): string {
  return attempt <= 1 ? info.zip : info.zip.replace(/\.zip$/, '-' + attempt + '.zip');
}

/** Save the verified ZIP to phone storage under the first free name. */
export function saveUpdate(bytes: Uint8Array, info: UpdateInfo, save = saveToDevicePath): Promise<SavedUpdate> {
  const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
  const attempt = (n: number): Promise<SavedUpdate> => {
    const name = candidateName(info, n);
    return save(STORAGE, blob, name).then(
      (path) => ({ name, path }),
      (e: { name?: string; message?: string }) => {
        dbg('update: saving ' + name + ' failed ' + (e && (e.name || e.message)));
        if (n >= MAX_NAME_TRIES || /storage (unavailable|path unknown)/.test(String(e && e.message))) throw updateError('UpdateStorage', 'could not save the update');
        return attempt(n + 1);
      }
    );
  };
  return attempt(1);
}
