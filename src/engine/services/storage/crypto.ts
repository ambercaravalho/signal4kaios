/* Storage Service key derivation and record encryption, as Signal-Desktop's Crypto.node.ts. */

import { concatBytes, toBase64 } from '../../bytes';
import { hkdfSha256, hmacSha256, openGcm } from '../../crypto/primitives';

const enc = new TextEncoder();
const ITEM_KEY_INFO_PREFIX = '20240801_SIGNAL_STORAGE_SERVICE_ITEM_';

export function deriveStorageServiceKey(masterKey: Uint8Array): Uint8Array {
  if (masterKey.length !== 32) throw new Error(`Invalid masterKey length: ${masterKey.length}`);
  return hmacSha256(masterKey, enc.encode('Storage Service Encryption'));
}

export function deriveStorageManifestKey(storageServiceKey: Uint8Array, version: bigint): Uint8Array {
  return hmacSha256(storageServiceKey, enc.encode(`Manifest_${version}`));
}

export function deriveStorageItemKey(storageServiceKey: Uint8Array, key: Uint8Array, recordIkm?: Uint8Array): Uint8Array {
  if (!recordIkm || recordIkm.length === 0) {
    return hmacSha256(storageServiceKey, enc.encode(`Item_${toBase64(key)}`));
  }
  return hkdfSha256(recordIkm, concatBytes(enc.encode(ITEM_KEY_INFO_PREFIX), key), 32, new Uint8Array(0));
}

export const decryptStorageValue = (key: Uint8Array, data: Uint8Array): Promise<Uint8Array> => openGcm(key, data);
