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

export function drawToCanvas(img: HTMLImageElement, g: DrawGeometry, background?: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = g.width;
  canvas.height = g.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, g.width, g.height);
  }
  ctx.drawImage(img, g.sx, g.sy, g.sw, g.sh, 0, 0, g.width, g.height);
  return canvas;
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

/** Re-encode `blob` as JPEG drawn with the geometry `layout` picks for its size. */
export async function scaleToJpeg(blob: Blob, layout: (w: number, h: number) => DrawGeometry, quality = 0.8, background?: string): Promise<Uint8Array> {
  const img = await loadImage(blob);
  return canvasJpeg(drawToCanvas(img, layout(img.naturalWidth, img.naturalHeight), background), quality);
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

/** A photo as Signal sends it at Standard quality: re-encoded as JPEG, which drops EXIF (location, camera, time). A JPEG the canvas can't re-encode goes with its metadata segments removed; GIFs and other formats go unchanged. */
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
