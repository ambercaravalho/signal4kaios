/* Downloading the link-and-sync archive from Signal's CDN in 1 MiB ranges, each saved as it arrives, so a download cut short resumes where it stopped (Signal-Desktop `downloadEphemeral`). */

import { SIGNAL_CDNS, type SignalHttpRawFn } from '../../net/http';

export const CHUNK_BYTES = 1024 * 1024;
const CHUNK_TIMEOUT_MS = 120 * 1000;

export interface ChunkSink {
  put(index: number, bytes: Uint8Array): Promise<void>;
}

/** The whole size from a `Content-Range: bytes a-b/total` header, or 0 when it's missing or unknown. */
export function rangeTotal(header: string | null | undefined): number {
  const m = /\/(\d+)\s*$/.exec(header || '');
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Download from chunk `from` on. `onChunk` runs after each chunk is saved, with the number saved so far, the bytes received, and the total size (0 while unknown). Resolves to the number of chunks once the archive is complete; rejects when `cancelled` turns true or a request fails.
 */
export async function downloadArchive(
  raw: SignalHttpRawFn,
  archive: { cdn: number; key: string },
  from: number,
  sink: ChunkSink,
  onChunk: (chunks: number, bytes: number, total: number) => Promise<void> | void,
  cancelled: () => boolean
): Promise<number> {
  const base = SIGNAL_CDNS[archive.cdn];
  if (!base) throw new Error('Unknown archive CDN ' + archive.cdn);
  const url = `${base}/attachments/${encodeURIComponent(archive.key)}`;
  let index = from;
  for (;;) {
    if (cancelled()) throw Object.assign(new Error('Download canceled'), { name: 'AbortError' });
    const start = index * CHUNK_BYTES;
    let res;
    try {
      res = await raw('GET', url, null, { Range: `bytes=${start}-${start + CHUNK_BYTES - 1}` }, CHUNK_TIMEOUT_MS);
    } catch (e: any) {
      if (e && e.status === 416 && index > 0) return index;
      throw e;
    }
    if (res.status === 200) {
      for (let i = 0; i * CHUNK_BYTES < res.body.length || i === 0; i++) await sink.put(i, res.body.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
      const count = Math.max(1, Math.ceil(res.body.length / CHUNK_BYTES));
      await onChunk(count, res.body.length, res.body.length);
      return count;
    }
    await sink.put(index, res.body);
    index += 1;
    const total = rangeTotal(res.range);
    const received = start + res.body.length;
    await onChunk(index, received, total);
    if (res.body.length < CHUNK_BYTES || (total > 0 && received >= total)) return index;
  }
}
