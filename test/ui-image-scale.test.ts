import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fitGeometry, photoGeometry, preparePhoto, squareGeometry, stripJpegMetadata } from '../src/ui/data/image-scale';

describe('image scaling', () => {
  it('crops the centered square for a profile photo', () => {
    assert.deepEqual(squareGeometry(1600, 1200, 512), { sx: 200, sy: 0, sw: 1200, sh: 1200, width: 512, height: 512 });
    assert.deepEqual(squareGeometry(600, 900, 512), { sx: 0, sy: 150, sw: 600, sh: 600, width: 512, height: 512 });
    assert.deepEqual(squareGeometry(300, 400, 512), { sx: 0, sy: 50, sw: 300, sh: 300, width: 300, height: 300 }, 'small photos are not enlarged');
  });

  it('fits the whole image inside the longest edge', () => {
    assert.deepEqual(fitGeometry(1600, 1200, 800), { sx: 0, sy: 0, sw: 1600, sh: 1200, width: 800, height: 600 });
    assert.deepEqual(fitGeometry(400, 300, 800), { sx: 0, sy: 0, sw: 400, sh: 300, width: 400, height: 300 });
    assert.deepEqual(fitGeometry(0, 0, 800), { sx: 0, sy: 0, sw: 1, sh: 1, width: 1, height: 1 });
  });

  it('sends chat photos at Standard quality, 1600 pixels on the longest edge', () => {
    assert.deepEqual(photoGeometry(4000, 3000), { sx: 0, sy: 0, sw: 4000, sh: 3000, width: 1600, height: 1200 });
    assert.deepEqual(photoGeometry(1200, 4800), { sx: 0, sy: 0, sw: 1200, sh: 4800, width: 400, height: 1600 });
    assert.deepEqual(photoGeometry(1024, 768), { sx: 0, sy: 0, sw: 1024, sh: 768, width: 1024, height: 768 });
  });
});

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
function segment(marker: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, marker, len >> 8, len & 0xff, ...payload];
}

const SOI = [0xff, 0xd8];
const APP0 = segment(0xe0, ascii('JFIF\0').concat([1, 2, 0, 0, 1, 0, 1, 0, 0]));
const EXIF = segment(0xe1, ascii('Exif\0\0MM\0*GPSLatitude 52.37 GPSLongitude 4.89'));
const XMP = segment(0xe1, ascii('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>'));
const IPTC = segment(0xed, ascii('Photoshop 3.0\0city Amsterdam'));
const DQT = segment(0xdb, [0, ...new Array(64).fill(1)]);
const SOF = segment(0xc0, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]);
const SCAN = [...segment(0xda, [1, 1, 0, 0, 63, 0]), 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56];
const EOI = [0xff, 0xd9];

describe('photo metadata', () => {
  it('removes Exif, XMP, and IPTC segments and keeps the image', () => {
    const jpeg = new Uint8Array([...SOI, ...APP0, ...EXIF, ...XMP, ...IPTC, ...DQT, ...SOF, ...SCAN, ...EOI]);
    const out = stripJpegMetadata(jpeg);
    assert.deepEqual(Array.from(out), [...SOI, ...APP0, ...DQT, ...SOF, ...SCAN, ...EOI]);
    assert.ok(!String.fromCharCode(...out).includes('GPS'));
  });

  it('returns other formats unchanged', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(stripJpegMetadata(png), png);
  });

  it('refuses a JPEG whose segments run past the end, rather than send it with its metadata', () => {
    const cut = new Uint8Array([...SOI, ...EXIF.slice(0, 10)]);
    assert.throws(() => stripJpegMetadata(cut), /malformed/);
  });

  it('re-encodes a PNG as a 1600-pixel JPEG on a white background', async () => {
    const g = globalThis as any;
    const drawn: Array<{ width: number; height: number; fill: string }> = [];
    g.Image = class {
      naturalWidth = 3200;
      naturalHeight = 2400;
      onload: (() => void) | null = null;
      set src(_url: string) {
        setTimeout(() => this.onload && this.onload(), 0);
      }
    };
    g.document = {
      createElement: () => {
        const canvas: any = { width: 0, height: 0 };
        const ctx: any = { fillStyle: '', fillRect: () => drawn.push({ width: canvas.width, height: canvas.height, fill: ctx.fillStyle }), drawImage: () => {} };
        canvas.getContext = () => ctx;
        canvas.toBlob = (cb: (b: Blob) => void, type: string) => cb(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type }));
        return canvas;
      },
    };
    try {
      const prepared = await preparePhoto(new Blob([new Uint8Array(8)], { type: 'image/png' }), 'Screenshot.png');
      assert.equal(prepared.contentType, 'image/jpeg');
      assert.equal(prepared.filename, 'Screenshot.jpg');
      assert.deepEqual(drawn, [{ width: 1600, height: 1200, fill: '#fff' }]);
    } finally {
      delete g.Image;
      delete g.document;
    }
  });

  it('strips a JPEG the canvas can’t re-encode and leaves a GIF alone', async () => {
    const jpeg = new Blob([new Uint8Array([...SOI, ...EXIF, ...DQT, ...SOF, ...SCAN, ...EOI])], { type: 'image/jpeg' });
    const prepared = await preparePhoto(jpeg, 'IMG_0001.JPG');
    assert.equal(prepared.contentType, 'image/jpeg');
    assert.equal(prepared.filename, 'IMG_0001.JPG');
    assert.deepEqual(Array.from(new Uint8Array(await prepared.blob.arrayBuffer())), [...SOI, ...DQT, ...SOF, ...SCAN, ...EOI]);

    const gif = new Blob([new Uint8Array(ascii('GIF89a'))], { type: 'image/gif' });
    const kept = await preparePhoto(gif, 'party.gif');
    assert.equal(kept.blob, gif);
    assert.equal(kept.filename, 'party.gif');
  });
});
