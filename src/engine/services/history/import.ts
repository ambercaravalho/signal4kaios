/* Reading a downloaded link-and-sync archive in two passes, as Signal-Desktop does: the first only checks its MAC, so nothing is imported from a file that was tampered with or cut short; the second decrypts it and maps its frames. libsignal's `BackupReader` does the cryptography. */

import { libsignal } from '../../protocol/libsignal';
import type { FrameMapper, HistoryItem } from './types';

export interface ChunkSource {
  count: number;
  get(index: number): Promise<Uint8Array>;
}

function canceled(): Error {
  return Object.assign(new Error('Import canceled'), { name: 'AbortError' });
}

/** Feed every chunk through a reader; `onFrames` gets what each one yields, and the last batch comes from `finish`. */
async function pass(
  // SECURITY-REVIEW: the archive's backup key; it is handed to libsignal and never logged.
  backupKey: Uint8Array,
  aci: string,
  decrypt: boolean,
  source: ChunkSource,
  onFrames: (frames: Uint8Array[], chunk: number) => Promise<void>,
  cancelled: () => boolean
): Promise<void> {
  const reader = new libsignal.BackupReader(backupKey, aci, decrypt);
  try {
    for (let i = 0; i < source.count; i++) {
      if (cancelled()) throw canceled();
      const frames = reader.push(await source.get(i)) as Uint8Array[];
      await onFrames(frames, i + 1);
    }
    await onFrames(reader.finish() as Uint8Array[], source.count);
  } finally {
    reader.free();
  }
}

/**
 * Check the archive, then map its frames. `onItems` gets each chunk's items in archive order (people and chats before the messages that name them); `onProgress` runs with the pass (1 or 2) and how many chunks it has read. Rejects with a `BackupBadMac`, `BackupCorrupt`, or `BackupUnsupported` error before anything is imported when the archive is unusable.
 */
export async function importArchive(
  backupKey: Uint8Array,
  aci: string,
  source: ChunkSource,
  mapper: FrameMapper,
  onItems: (items: HistoryItem[]) => Promise<void>,
  onProgress: (passNumber: 1 | 2, chunks: number, total: number) => void,
  cancelled: () => boolean
): Promise<void> {
  await pass(backupKey, aci, false, source, async (_frames, chunk) => onProgress(1, chunk, source.count), cancelled);
  await pass(
    backupKey,
    aci,
    true,
    source,
    async (frames, chunk) => {
      const items: HistoryItem[] = [];
      for (const f of frames) {
        let item: HistoryItem | null = null;
        try {
          item = mapper.map(f);
        } catch (e: any) {
          // One unreadable frame costs that message only, as in Signal-Desktop's import.
          if (e && e.name === 'BackupUnsupported') throw e;
        }
        if (item) items.push(item);
      }
      if (items.length) await onItems(items);
      onProgress(2, chunk, source.count);
    },
    cancelled
  );
}
