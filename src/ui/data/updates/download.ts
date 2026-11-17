/* Downloads a release's ZIP, checks it against `update.json`, and saves it where the phone's install service and OStore can read it. */

import { toHex } from '../../../engine/bytes';
import { hashSha256 } from '../../../engine/crypto/primitives';
import { isReleaseVersion } from '../../../engine/validate';
import { config } from '../config';
import { http } from '../http';
import { dbg } from '../log';
import { appVersion, deleteFromDevice, saveToDevicePath } from '../platform';
import { compareVersions, RELEASES_URL, type UpdateInfo } from './check';

/** Phone storage the update is saved to. `addNamed` never replaces an existing file, and Beacon deletes only the files it recorded in `updateFiles`. */
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

/** Save the verified ZIP to phone storage under the first free name, and record it so it can be deleted later. */
export function saveUpdate(bytes: Uint8Array, info: UpdateInfo, save = saveToDevicePath): Promise<SavedUpdate> {
  const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
  const attempt = (n: number): Promise<SavedUpdate> => {
    const name = candidateName(info, n);
    return save(STORAGE, blob, name).then(
      (file) => {
        config.set({ updateFiles: [...config.updateFiles().filter((f) => f.stored !== file.stored), { stored: file.stored, version: info.version }] });
        return { name, path: file.path };
      },
      (e: { name?: string; message?: string }) => {
        dbg('update: saving ' + name + ' failed ' + (e && (e.name || e.message)));
        if (n >= MAX_NAME_TRIES || /storage (unavailable|path unknown)/.test(String(e && e.message))) throw updateError('UpdateStorage', 'could not save the update');
        return attempt(n + 1);
      }
    );
  };
  return attempt(1);
}

function isGone(e: { name?: string; message?: string } | null | undefined): boolean {
  return !!e && (e.name === 'NotFoundError' || /not ?found/i.test(String(e.message)));
}

/** Delete the update ZIPs Beacon saved, except those whose version `keep` accepts. Only files listed in `updateFiles` are touched; one the user already deleted is dropped from the list. */
export async function deleteSavedUpdates(keep: (version: string) => boolean = () => false, remove = deleteFromDevice): Promise<void> {
  const done: string[] = [];
  for (const file of config.updateFiles()) {
    if (keep(file.version)) continue;
    try {
      await remove(STORAGE, file.stored);
      done.push(file.stored);
    } catch (e: any) {
      if (isGone(e)) done.push(file.stored);
      else dbg('update: deleting ' + file.stored + ' failed ' + (e && (e.name || e.message)));
    }
  }
  if (done.length) config.set({ updateFiles: config.updateFiles().filter((f) => done.indexOf(f.stored) < 0) });
}

/** On launch: delete the saved updates for this version or older, which are installed or out of date. */
export function deleteInstalledUpdates(): Promise<void> {
  if (!config.updateFiles().length) return Promise.resolve();
  return appVersion().then((installed) => (isReleaseVersion(installed) ? deleteSavedUpdates((v) => isReleaseVersion(v) && compareVersions(v, installed) > 0) : undefined));
}
