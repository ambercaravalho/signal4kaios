/* The `s4katt:` attachment IDs the app stores in messages: everything needed to download and decrypt one attachment from Signal's CDN. */

import { fromBase64, toBase64 } from '../bytes';

export interface AttachmentDescriptor {
  cdnKey: string;
  cdnNumber: number;
  key: Uint8Array;
  digest?: Uint8Array;
  /** SHA-256 of the plaintext, which link-and-sync archives carry instead of a digest. */
  plaintextHash?: Uint8Array;
  contentType: string;
  fileName: string;
  size: number;
}

export function encodeAttachmentDescriptor(d: AttachmentDescriptor): string {
  const meta: Record<string, unknown> = {
    cdnKey: d.cdnKey,
    cdnNumber: d.cdnNumber,
    key: toBase64(d.key),
    digest: d.digest && d.digest.length ? toBase64(d.digest) : '',
    contentType: d.contentType,
    fileName: d.fileName,
    size: d.size,
  };
  if (d.plaintextHash && d.plaintextHash.length) meta.plaintextHash = toBase64(d.plaintextHash);
  return 's4katt:' + toBase64(new TextEncoder().encode(JSON.stringify(meta)));
}

export function decodeAttachmentDescriptor(id: string): AttachmentDescriptor | null {
  if (!id || !id.startsWith('s4katt:')) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64(id.slice(7))));
    if (typeof parsed.cdnKey !== 'string' || !parsed.cdnKey) return null;
    const out: AttachmentDescriptor = {
      cdnKey: parsed.cdnKey,
      cdnNumber: typeof parsed.cdnNumber === 'number' ? parsed.cdnNumber : 0,
      key: fromBase64(parsed.key || ''),
      digest: parsed.digest ? fromBase64(parsed.digest) : undefined,
      contentType: parsed.contentType || 'application/octet-stream',
      fileName: parsed.fileName || '',
      size: typeof parsed.size === 'number' ? parsed.size : 0,
    };
    if (typeof parsed.plaintextHash === 'string' && parsed.plaintextHash) out.plaintextHash = fromBase64(parsed.plaintextHash);
    return out;
  } catch {
    return null;
  }
}
