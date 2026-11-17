import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { _setOrientationSupportForTest, fitGeometry, jpegOrientation, orientationSupport, orientationTransform, photoGeometry, preparePhoto, scaleToJpeg, squareGeometry, stripJpegMetadata } from '../src/ui/data/image-scale';

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

function tiff(order: 'MM' | 'II', entries: Array<[number, number, number]>): number[] {
  const u16 = (n: number) => (order === 'MM' ? [n >> 8, n & 0xff] : [n & 0xff, n >> 8]);
  const u32 = (n: number) => (order === 'MM' ? [0, 0, ...u16(n)] : [...u16(n), 0, 0]);
  const ifd = entries.flatMap(([tag, type, value]) => [...u16(tag), ...u16(type), ...u32(1), ...u16(value), 0, 0]);
  return [...ascii(order), ...u16(42), ...u32(8), ...u16(entries.length), ...ifd, ...u32(0)];
}
const exifWith = (order: 'MM' | 'II', orientation: number, type = 3) => segment(0xe1, [...ascii('Exif\0\0'), ...tiff(order, [[0x0110, 2, 0], [0x0112, type, orientation]])]);
const BLUEIMP_TEST_JPEG = Buffer.from('/9j/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wCEAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAf/AABEIAAIAAwMBEQACEQEDEQH/xABRAAEAAAAAAAAAAAAAAAAAAAAKEAEBAQADAQEAAAAAAAAAAAAGBQQDCAkCBwEBAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AG8T9NfSMEVMhQvoP3fFiRZ+MTHDifa/95OFSZU5OzRzxkyejv8ciEfhSceSXGjS8eSdLnZc2HDm4M3BxcXwH/9k=', 'base64');

type Op = [string, ...unknown[]];
function stubCanvas(natural: [number, number], pixel = [255, 255, 255, 255]) {
  const g = globalThis as any;
  const canvases: Array<{ width: number; height: number; ops: Op[] }> = [];
  g.Image = class {
    naturalWidth = natural[0];
    naturalHeight = natural[1];
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_url: string) {
      setTimeout(() => this.onload && this.onload(), 0);
    }
  };
  g.document = {
    createElement: () => {
      const canvas: any = { width: 0, height: 0, ops: [] as Op[] };
      const ctx = {
        fillStyle: '',
        fillRect: () => {},
        setTransform: (...m: number[]) => canvas.ops.push(['setTransform', ...m]),
        drawImage: (src: unknown, ...args: number[]) => canvas.ops.push(['drawImage', src, ...args]),
        getImageData: () => ({ data: new Uint8ClampedArray(pixel) }),
      };
      canvas.getContext = () => ctx;
      canvas.toBlob = (cb: (b: Blob) => void, type: string) => cb(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type }));
      canvases.push(canvas);
      return canvas;
    },
  };
  return {
    canvases,
    restore() {
      delete g.Image;
      delete g.document;
      _setOrientationSupportForTest(null);
    },
  };
}

describe('photo orientation', () => {
  it('reads the Exif orientation in either byte order', () => {
    assert.equal(jpegOrientation(new Uint8Array([...SOI, ...APP0, ...exifWith('MM', 6), ...DQT, ...SOF, ...SCAN, ...EOI])), 6);
    assert.equal(jpegOrientation(new Uint8Array([...SOI, ...exifWith('II', 8), ...SCAN, ...EOI])), 8);
    assert.equal(jpegOrientation(new Uint8Array([...SOI, ...XMP, ...exifWith('II', 3)])), 3, 'after an XMP segment');
    assert.equal(jpegOrientation(new Uint8Array(BLUEIMP_TEST_JPEG)), 6, 'blueimp-load-image’s test image');
  });

  it('treats a photo without a usable orientation as upright', () => {
    assert.equal(jpegOrientation(new Uint8Array([...SOI, ...APP0, ...DQT, ...SOF, ...SCAN, ...EOI])), 1, 'no Exif');
    assert.equal(jpegOrientation(new Uint8Array([...SOI, ...EXIF, ...SCAN, ...EOI])), 1, 'Exif that isn’t TIFF');
    assert.equal(jpegOrientation(new Uint8Array([...SOI, ...exifWith('MM', 9)])), 1, 'out of range');
    assert.equal(jpegOrientation(new Uint8Array([...SOI, ...exifWith('MM', 6, 4)])), 1, 'not a SHORT');
    assert.equal(jpegOrientation(new Uint8Array([...SOI, ...exifWith('MM', 6).slice(0, 30)])), 1, 'cut off');
    const lying = segment(0xe1, [...ascii('Exif\0\0'), ...ascii('MM'), 0, 42, 0xff, 0xff, 0xff, 0xf0]);
    assert.equal(jpegOrientation(new Uint8Array([...SOI, ...lying])), 1, 'IFD offset past the end');
    const many = segment(0xe1, [...ascii('Exif\0\0'), ...ascii('MM'), 0, 42, 0, 0, 0, 8, 0xff, 0xff]);
    assert.equal(jpegOrientation(new Uint8Array([...SOI, ...many])), 1, 'more entries than bytes');
    assert.equal(jpegOrientation(new Uint8Array(ascii('GIF89a'))), 1, 'not a JPEG');
  });

  it('turns each orientation upright inside the canvas', () => {
    const w = 4;
    const h = 2;
    const at = (m: number[], x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    const corner = (W: number, H: number, p: number[]) => (p[1] === 0 ? 'T' : p[1] === H ? 'B' : '?') + (p[0] === 0 ? 'L' : p[0] === W ? 'R' : '?');
    const topLeft = ['TL', 'TR', 'BR', 'BL', 'TL', 'TR', 'BR', 'BL'];
    const topRight = ['TR', 'TL', 'BL', 'BR', 'BL', 'BR', 'TR', 'TL'];
    for (let o = 1; o <= 8; o++) {
      const m = orientationTransform(o, w, h);
      const [W, H] = o > 4 ? [h, w] : [w, h];
      assert.equal(corner(W, H, at(m, 0, 0)), topLeft[o - 1], `orientation ${o}, stored top left`);
      assert.equal(corner(W, H, at(m, w, 0)), topRight[o - 1], `orientation ${o}, stored top right`);
      assert.notEqual(corner(W, H, at(m, w, h)), corner(W, H, at(m, 0, 0)), `orientation ${o} keeps the image in the canvas`);
    }
  });

  it('sends a photo taken sideways upright when the browser doesn’t turn it', async () => {
    const stub = stubCanvas([3200, 2400]);
    _setOrientationSupportForTest({ orients: false, cropBug: false });
    try {
      const jpeg = new Blob([new Uint8Array([...SOI, ...exifWith('MM', 6), ...DQT, ...SOF, ...SCAN, ...EOI])], { type: 'image/jpeg' });
      const prepared = await preparePhoto(jpeg, 'IMG_0002.JPG');
      assert.equal(prepared.contentType, 'image/jpeg');
      const [canvas] = stub.canvases;
      assert.deepEqual([canvas.width, canvas.height], [1200, 1600]);
      assert.deepEqual(canvas.ops[0], ['setTransform', 0, 1, -1, 0, 1200, 0]);
      assert.deepEqual(canvas.ops[1].slice(2), [0, 0, 3200, 2400, 0, 0, 1600, 1200]);
    } finally {
      stub.restore();
    }
  });

  it('leaves the turning to a browser that does it', async () => {
    const stub = stubCanvas([2400, 3200]);
    _setOrientationSupportForTest({ orients: true, cropBug: false });
    try {
      const jpeg = new Blob([new Uint8Array([...SOI, ...exifWith('MM', 6), ...DQT, ...SOF, ...SCAN, ...EOI])], { type: 'image/jpeg' });
      await preparePhoto(jpeg, 'IMG_0003.JPG');
      const [canvas] = stub.canvases;
      assert.deepEqual([canvas.width, canvas.height], [1200, 1600]);
      assert.deepEqual(canvas.ops.map((op) => op[0]), ['drawImage']);
    } finally {
      stub.restore();
    }
  });

  it('crops a profile photo from the whole image when the browser crops turned images wrongly', async () => {
    const stub = stubCanvas([1600, 1200]);
    _setOrientationSupportForTest({ orients: true, cropBug: true });
    try {
      await scaleToJpeg(new Blob([new Uint8Array(8)], { type: 'image/jpeg' }), (w, h) => squareGeometry(w, h, 600));
      const [whole, crop] = stub.canvases;
      assert.deepEqual([whole.width, whole.height], [800, 600]);
      assert.deepEqual(whole.ops[0].slice(2), [0, 0, 1600, 1200, 0, 0, 800, 600]);
      assert.deepEqual([crop.width, crop.height], [600, 600]);
      assert.equal(crop.ops[0][1], whole, 'cropped from the whole image');
      assert.deepEqual(crop.ops[0].slice(2), [100, 0, 600, 600, 0, 0, 600, 600]);
    } finally {
      stub.restore();
    }
  });

  it('checks once whether the browser turns photos, as blueimp-load-image does', async () => {
    let stub = stubCanvas([2, 3]);
    try {
      assert.deepEqual(await orientationSupport(), { orients: true, cropBug: false });
      assert.equal(orientationSupport(), orientationSupport(), 'cached');
    } finally {
      stub.restore();
    }
    stub = stubCanvas([2, 3], [0, 0, 0, 0]);
    try {
      assert.deepEqual(await orientationSupport(), { orients: true, cropBug: true });
    } finally {
      stub.restore();
    }
    stub = stubCanvas([3, 2]);
    try {
      assert.deepEqual(await orientationSupport(), { orients: false, cropBug: false });
    } finally {
      stub.restore();
    }
  });
});
