/* Loading `build/backup.js` (./bundle.ts) on first use. */

import type { CreateFrameMapper } from './types';

export const BACKUP_GLOBAL = 'signal4kaiosBackup';
const BACKUP_SCRIPT = 'build/backup.js';

let loading: Promise<CreateFrameMapper> | null = null;

function loaded(): CreateFrameMapper | null {
  const g = (globalThis as any)[BACKUP_GLOBAL];
  return g && typeof g.createFrameMapper === 'function' ? g.createFrameMapper : null;
}

export function loadFrameMapper(): Promise<CreateFrameMapper> {
  const ready = loaded();
  if (ready) return Promise.resolve(ready);
  if (loading) return loading;
  loading = new Promise<CreateFrameMapper>((resolve, reject) => {
    if (typeof document === 'undefined') return reject(new Error('Archive decoder unavailable'));
    const s = document.createElement('script');
    s.src = BACKUP_SCRIPT;
    s.onload = () => {
      const fn = loaded();
      if (fn) resolve(fn);
      else reject(new Error('Archive decoder unavailable'));
    };
    s.onerror = () => reject(new Error('Archive decoder unavailable'));
    document.head.appendChild(s);
  });
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
