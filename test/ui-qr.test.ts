import './ui-env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decodeQrPixels, qrGrid } from '../src/ui/components/Qr';

/** A grid as an RGBA image, `scale` pixels per module, with extra white margin. */
function pixels(grid: boolean[][], scale = 4, margin = 4) {
  const size = (grid.length + margin * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < grid.length; y++)
    for (let x = 0; x < grid.length; x++) {
      if (!grid[y][x]) continue;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + margin) * scale + dy) * size + (x + margin) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
    }
  return { width: size, height: size, data };
}

const bytesOf = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/** Shaped like a serialized ScannableFingerprint: version 2, then two 32-byte fingerprints, with plenty of bytes above 0x7f. */
const FINGERPRINT = new Uint8Array([0x08, 0x02, 0x12, 0x22, 0x0a, 0x20, ...Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 255), 0x1a, 0x22, 0x0a, 0x20, ...Array.from({ length: 32 }, (_, i) => (i * 53 + 200) & 255)]);

describe('safety number QR codes', () => {
  it('draws the raw fingerprint bytes and reads them back exactly', () => {
    const img = pixels(qrGrid(FINGERPRINT));
    const scanned = decodeQrPixels(img, true);
    assert.ok(scanned);
    assert.deepEqual(bytesOf(scanned), Array.from(FINGERPRINT));
    const asText = decodeQrPixels(img);
    assert.notDeepEqual(asText && bytesOf(asText), Array.from(FINGERPRINT), 'a UTF-8 read corrupts the bytes');
  });

  it('leaves text codes as they were', () => {
    const link = 'https://signal.me/#eu/abc';
    assert.equal(decodeQrPixels(pixels(qrGrid(link))), link);
    assert.equal(decodeQrPixels(pixels(qrGrid(link)), true), link);
  });
});
