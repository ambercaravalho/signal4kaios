/* Downloaded attachments, cached in IndexedDB with a small LRU so chats and the viewer share one copy. */

import { signal } from './api';
import { db } from './db';
import type { Attachment } from './types';

export const ATTACHMENT_CACHE_KEEP = 150;
/** Photos up to this size download on their own when they scroll into view. */
const AUTO_DOWNLOAD_BYTES = 400 * 1024;

export class ViewedOnceError extends Error {}
export class NotDownloadableError extends Error {}

const pending: Record<string, Promise<Blob>> = {};

export function isImage(att: Attachment): boolean {
  return (att.contentType || '').indexOf('image/') === 0;
}

export function autoDownloads(att: Attachment): boolean {
  return !!att.id && isImage(att) && !att.viewOnce && (!att.size || att.size <= AUTO_DOWNLOAD_BYTES);
}

/** The attachment's bytes from cache or Signal's servers. View-once media is kept only in memory and marked as viewed. */
export function loadAttachment(att: Attachment): Promise<Blob> {
  if (!att.id) return Promise.reject(new NotDownloadableError('no id'));
  if (!pending[att.id]) {
    pending[att.id] = db
      .getAttachment(att.id)
      .then((row) => {
        if (row && row.blob) {
          if (!row.blob.size) throw new ViewedOnceError('viewed');
          return row.blob;
        }
        return signal.downloadAttachmentBlob(att.id).then((blob) => {
          if (att.viewOnce) db.putAttachment(att.id, new Blob([]), '');
          else db.putAttachment(att.id, blob, att.contentType).then(() => db.pruneAttachments(ATTACHMENT_CACHE_KEEP));
          return blob;
        });
      })
      .finally(() => {
        delete pending[att.id];
      });
  }
  return pending[att.id];
}

/** The cached copy only, without downloading. */
export function cachedAttachment(att: Attachment): Promise<Blob | null> {
  if (!att.id) return Promise.resolve(null);
  return db.getAttachment(att.id).then(
    (row) => (row && row.blob && row.blob.size ? row.blob : null),
    () => null
  );
}

/** A file or downloaded attachment as the "data:<mime>;filename=…;base64,…" URI the send path takes. */
export function readDataUri(blob: Blob, filename?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const uri = String(r.result);
      if (!filename) return resolve(uri);
      const safe = String(filename).replace(/[;,]/g, '_');
      resolve(uri.replace(/^data:([^;,]*);base64,/, 'data:$1;filename=' + safe + ';base64,'));
    };
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

/** The bytes of a "data:<mime>;…;base64,…" URI from `readDataUri`, or null when it isn't one. */
export function dataUriBlob(uri: string): Blob | null {
  const m = /^data:([^;,]*)[^,]*;base64,/.exec(uri);
  if (!m) return null;
  try {
    const bin = atob(uri.slice(m[0].length));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] || 'application/octet-stream' });
  } catch (_) {
    return null;
  }
}

export function storageKindFor(type: string): string {
  if (type.indexOf('image/') === 0) return 'pictures';
  if (type.indexOf('audio/') === 0) return 'music';
  if (type.indexOf('video/') === 0) return 'videos';
  return 'sdcard';
}

const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'audio/aac': '.aac', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'video/mp4': '.mp4' };

export function fileNameFor(att: Attachment, type: string): string {
  return att.filename || 'signal_' + Date.now() + (EXT[type] || '');
}
