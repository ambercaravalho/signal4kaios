/* Our own profile photo as an object URL for this session, reloaded when we change it or a Storage Service pull might have. */

import { signal } from './api';

let url: string | null | undefined;
let pending: Promise<string | null> | null = null;
const listeners = new Set<() => void>();

export function loadOwnPhoto(): Promise<string | null> {
  if (url !== undefined) return Promise.resolve(url);
  if (!pending) {
    const load = signal
      .ownAvatarBlob()
      .then((blob) => (blob && blob.size && (blob.type || '').indexOf('image/') === 0 ? URL.createObjectURL(blob) : null))
      .catch(() => null)
      .then((u) => {
        if (pending === load) url = u;
        return u;
      });
    pending = load;
  }
  return pending;
}

/** Drop the cached photo so every own avatar loads it again. */
export function ownPhotoChanged(): void {
  if (url) URL.revokeObjectURL(url);
  url = undefined;
  pending = null;
  listeners.forEach((f) => f());
}

export function onOwnPhotoChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
