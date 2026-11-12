/* Installed sticker packs (Storage record type 6) and the phone's install and remove sync messages, kept as a list the way Signal-Desktop's storageRecordOps reads them. Beacon has no sticker picker, so it never writes them. */

import { toHex } from '../../bytes';
import type { InstalledStickerPackRecord } from '../../gen/SignalStorage_pb';
import { type SyncMessage_StickerPackOperation, SyncMessage_StickerPackOperation_Type } from '../../gen/SignalService_pb';
import type { HostStickerPack } from '../../host';

const MAX_PACKS = 500;

/** A pack as the app keeps it; null once it's deleted or malformed. */
export function readStickerPack(r: InstalledStickerPackRecord): HostStickerPack | null {
  if (r.deletedAtTimestamp > 0n || r.packId.length !== 16 || r.packKey.length !== 32) return null;
  return { id: toHex(r.packId), key: toHex(r.packKey), position: r.position };
}

/** Packs in display order: by position, then pack ID. */
export function sortStickerPacks(packs: HostStickerPack[]): HostStickerPack[] {
  return packs.slice(0, MAX_PACKS).sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The list after the phone installed or removed packs (`SyncMessage.stickerPackOperation`). A new pack goes last, as Signal-Desktop places it. */
export function applyStickerPackOperations(packs: HostStickerPack[], ops: SyncMessage_StickerPackOperation[]): HostStickerPack[] {
  let out = packs.slice();
  for (const op of ops) {
    if (op.packId.length !== 16) continue;
    const id = toHex(op.packId);
    out = out.filter((p) => p.id !== id);
    if (op.type === SyncMessage_StickerPackOperation_Type.INSTALL && op.packKey.length === 32) {
      const position = out.reduce((max, p) => Math.max(max, p.position + 1), 0);
      out.push({ id, key: toHex(op.packKey), position });
    }
  }
  return sortStickerPacks(out);
}
