/* Canvas image scaling shared by link previews, the profile photo, and chat photos. */

export interface DrawGeometry {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  width: number;
  height: number;
}

/** The whole image, with its longest edge at most `maxEdge`. */
export function fitGeometry(w: number, h: number, maxEdge: number): DrawGeometry {
  const iw = Math.max(1, w || 1);
  const ih = Math.max(1, h || 1);
  const scale = Math.min(1, maxEdge / Math.max(iw, ih));
  return { sx: 0, sy: 0, sw: iw, sh: ih, width: Math.max(1, Math.round(iw * scale)), height: Math.max(1, Math.round(ih * scale)) };
}

/** The centered square of the image, drawn at `edge` by `edge` (smaller images aren't enlarged). */
export function squareGeometry(w: number, h: number, edge: number): DrawGeometry {
  const iw = Math.max(1, w || 1);
  const ih = Math.max(1, h || 1);
  const side = Math.min(iw, ih);
  const out = Math.min(edge, side);
  return { sx: Math.floor((iw - side) / 2), sy: Math.floor((ih - side) / 2), sw: side, sh: side, width: out, height: out };
}

export function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('bad image'));
    };
    img.src = url;
  });
}

type Matrix = [number, number, number, number, number, number];

/** blueimp-load-image's canvas transform for Exif orientation 1 to 8, as a `setTransform` matrix: it maps an image drawn at `w` by `h` as stored onto the upright canvas (`h` by `w` for 5 to 8). */
export function orientationTransform(orientation: number, w: number, h: number): Matrix {
  switch (orientation) {
    case 2:
      return [-1, 0, 0, 1, w, 0];
    case 3:
      return [-1, 0, 0, -1, w, h];
    case 4:
      return [1, 0, 0, -1, 0, h];
    case 5:
      return [0, 1, 1, 0, 0, 0];
    case 6:
      return [0, 1, -1, 0, h, 0];
    case 7:
      return [0, -1, -1, 0, h, w];
    case 8:
      return [0, -1, 1, 0, 0, w];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

/** Draws `g`, laid out on the upright image, from an image stored with Exif `orientation`. The layout must be centered (as `fitGeometry` and `squareGeometry` are), since only the axes of its source rectangle are swapped. */
export function drawToCanvas(img: CanvasImageSource, g: DrawGeometry, background?: string, orientation = 1): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = g.width;
  canvas.height = g.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, g.width, g.height);
  }
  if (orientation > 1 && orientation < 9) {
    const s = orientation > 4 ? { sx: g.sy, sy: g.sx, sw: g.sh, sh: g.sw, width: g.height, height: g.width } : g;
    ctx.setTransform(...orientationTransform(orientation, s.width, s.height));
    ctx.drawImage(img, s.sx, s.sy, s.sw, s.sh, 0, 0, s.width, s.height);
  } else {
    ctx.drawImage(img, g.sx, g.sy, g.sw, g.sh, 0, 0, g.width, g.height);
  }
  return canvas;
}

export interface OrientationSupport {
  /** The browser already draws JPEGs upright from their Exif orientation. */
  orients: boolean;
  /** It does, but crops an upright image from the wrong source rectangle (Chromium bug 1074354). */
  cropBug: boolean;
}

/** blueimp-load-image's test image: a black and white 3x2 JPEG (BFF over BBB) tagged with Exif orientation 6. */
const ORIENTATION_TEST_JPEG =
  '/9j/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wCEAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAf/AABEIAAIAAwMBEQACEQEDEQH/xABRAAEAAAAAAAAAAAAAAAAAAAAKEAEBAQADAQEAAAAAAAAAAAAGBQQDCAkCBwEBAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AG8T9NfSMEVMhQvoP3fFiRZ+MTHDifa/95OFSZU5OzRzxkyejv8ciEfhSceSXGjS8eSdLnZc2HDm4M3BxcXwH/9k=';

let support: Promise<OrientationSupport> | null = null;

async function detectOrientationSupport(): Promise<OrientationSupport> {
  const bytes = Uint8Array.from(atob(ORIENTATION_TEST_JPEG), (c) => c.charCodeAt(0));
  const img = await loadImage(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
  const orients = img.naturalWidth === 2 && img.naturalHeight === 3;
  if (!orients) return { orients, cropBug: false };
  const ctx = drawToCanvas(img, { sx: 1, sy: 1, sw: 1, sh: 1, width: 1, height: 1 }).getContext('2d');
  return { orients, cropBug: !!ctx && Array.from(ctx.getImageData(0, 0, 1, 1).data).join(',') !== '255,255,255,255' };
}

/** Whether this browser applies Exif orientation itself, checked once as blueimp-load-image does. If the check can't run, Beacon leaves orientation to the browser, as before. */
export function orientationSupport(): Promise<OrientationSupport> {
  if (!support) support = detectOrientationSupport().catch(() => ({ orients: true, cropBug: false }));
  return support;
}

export function _setOrientationSupportForTest(s: OrientationSupport | null): void {
  support = s ? Promise.resolve(s) : null;
}

const EXIF_SCAN_BYTES = 128 * 1024;
const ORIENTATION_TAG = 0x0112;
const TIFF_SHORT = 3;

function tiffOrientation(t: Uint8Array): number {
  if (t.length < 8) return 1;
  const little = t[0] === 0x49 && t[1] === 0x49;
  if (!little && !(t[0] === 0x4d && t[1] === 0x4d)) return 1;
  const u16 = (o: number) => (little ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
  const u32 = (o: number) => (little ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0 : ((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0);
  if (u16(2) !== 42) return 1;
  const ifd = u32(4);
  if (ifd < 8 || ifd + 2 > t.length) return 1;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > t.length) return 1;
    if (u16(e) !== ORIENTATION_TAG) continue;
    const value = u16(e + 8);
    return u16(e + 2) === TIFF_SHORT && value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

/** The Exif orientation (1 to 8) of a JPEG, read from its first segments; 1 when there is none, or the data doesn't parse. */
export function jpegOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return 1;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === SOS || marker === EOI) return 1;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const end = i + 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    if (end < i + 4 || end > bytes.length) return 1;
    if (marker === APP1 && end - i >= 10 && String.fromCharCode(...bytes.subarray(i + 4, i + 10)) === 'Exif\0\0') return tiffOrientation(bytes.subarray(i + 10, end));
    i = end;
  }
  return 1;
}

function crops(g: DrawGeometry, w: number, h: number): boolean {
  return g.sx !== 0 || g.sy !== 0 || g.sw !== w || g.sh !== h;
}

/** blueimp-load-image's workaround for `cropBug`: draw the whole image at the output scale first, then crop from that. */
function drawCropped(img: HTMLImageElement, g: DrawGeometry, background?: string): HTMLCanvasElement {
  const scale = g.width / g.sw;
  const whole = drawToCanvas(img, fitGeometry(img.naturalWidth, img.naturalHeight, Math.round(Math.max(img.naturalWidth, img.naturalHeight) * scale)));
  const at = (n: number) => Math.round(n * scale);
  return drawToCanvas(whole, { sx: at(g.sx), sy: at(g.sy), sw: at(g.sw), sh: at(g.sh), width: g.width, height: g.height }, background);
}

function canvasJpeg(canvas: HTMLCanvasElement, quality = 0.8): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('encode failed'));
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      },
      'image/jpeg',
      quality
    );
  });
}

/** Re-encode `blob` as an upright JPEG drawn with the geometry `layout` picks for its upright size. */
export async function scaleToJpeg(blob: Blob, layout: (w: number, h: number) => DrawGeometry, quality = 0.8, background?: string): Promise<Uint8Array> {
  const s = await orientationSupport();
  const img = await loadImage(blob);
  const orientation = s.orients ? 1 : jpegOrientation(new Uint8Array(await blob.slice(0, EXIF_SCAN_BYTES).arrayBuffer()));
  const turned = orientation > 4;
  const w = turned ? img.naturalHeight : img.naturalWidth;
  const h = turned ? img.naturalWidth : img.naturalHeight;
  const g = layout(w, h);
  const canvas = s.cropBug && crops(g, w, h) ? drawCropped(img, g, background) : drawToCanvas(img, g, background, orientation);
  return canvasJpeg(canvas, quality);
}

/** Signal's Standard photo quality. */
const PHOTO_MAX_EDGE = 1600;
const PHOTO_QUALITY = 0.8;
const REENCODED_PHOTOS = ['image/jpeg', 'image/png', 'image/webp'];

export function photoGeometry(w: number, h: number): DrawGeometry {
  return fitGeometry(w, h, PHOTO_MAX_EDGE);
}

export interface PreparedPhoto {
  blob: Blob;
  contentType: string;
  filename: string;
}

function jpgName(name: string): string {
  if (!name) return '';
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name) + '.jpg';
}

/** A photo as Signal sends it at Standard quality: re-encoded upright as JPEG, which drops EXIF (location, camera, time). A JPEG the canvas can't re-encode goes with its metadata segments removed; GIFs and other formats go unchanged. */
export async function preparePhoto(file: Blob, filename: string): Promise<PreparedPhoto> {
  const type = file.type;
  if (REENCODED_PHOTOS.indexOf(type) < 0) return { blob: file, contentType: type, filename };
  try {
    const bytes = await scaleToJpeg(file, photoGeometry, PHOTO_QUALITY, '#fff');
    return { blob: new Blob([bytes as BlobPart], { type: 'image/jpeg' }), contentType: 'image/jpeg', filename: jpgName(filename) };
  } catch {
    if (type !== 'image/jpeg') return { blob: file, contentType: type, filename };
    const stripped = stripJpegMetadata(new Uint8Array(await file.arrayBuffer()));
    return { blob: new Blob([stripped as BlobPart], { type }), contentType: type, filename };
  }
}

const APP1 = 0xe1;
const APP13 = 0xed;
const SOS = 0xda;
const EOI = 0xd9;

/** Removes the APP1 (Exif, XMP) and APP13 (IPTC) segments from a JPEG, keeping every other segment and the image data. Input that doesn't start like a JPEG is returned unchanged; a JPEG whose segments don't parse throws rather than go out with its metadata. */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  for (;;) {
    if (i + 1 >= bytes.length || bytes[i] !== 0xff) throw new Error('malformed JPEG');
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === SOS || marker === EOI) {
      parts.push(bytes.subarray(i));
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(bytes.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 3 >= bytes.length) throw new Error('malformed JPEG');
    const end = i + 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    if (end > bytes.length || end < i + 4) throw new Error('malformed JPEG');
    if (marker !== APP1 && marker !== APP13) parts.push(bytes.subarray(i, end));
    i = end;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
