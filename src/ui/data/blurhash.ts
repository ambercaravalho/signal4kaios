/* Blurred placeholders for photos and videos: a hash made for photos we send, as Signal-Desktop does, and a small picture drawn from the hash on ones we receive until they download. */

import { decode, encode } from 'blurhash';
import { drawToCanvas, fitGeometry, loadImage } from './image-scale';

const ENCODE_EDGE = 32;
const DECODE_PIXELS = 32 * 32;
const MAX_CACHED = 100;

/** Desktop's 4 by 3 components. */
export function hashPixels(rgba: Uint8ClampedArray, width: number, height: number): string {
  return encode(rgba, width, height, 4, 3);
}

/** A photo's blurhash and size, or null when it can't be read. */
export async function photoBlurHash(blob: Blob): Promise<{ blurHash: string; width: number; height: number } | null> {
  try {
    const img = await loadImage(blob);
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    const canvas = drawToCanvas(img, fitGeometry(width, height, ENCODE_EDGE));
    const ctx = canvas.getContext('2d');
    if (!ctx || !width || !height) return null;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { blurHash: hashPixels(data.data, canvas.width, canvas.height), width, height };
  } catch {
    return null;
  }
}

/** The placeholder's own size: about 1024 pixels in the photo's shape. */
export function placeholderSize(width?: number, height?: number): { width: number; height: number } {
  const aspect = width && height ? Math.min(4, Math.max(0.25, height / width)) : 1;
  const w = Math.max(4, Math.round(Math.sqrt(DECODE_PIXELS / aspect)));
  return { width: w, height: Math.max(4, Math.round(w * aspect)) };
}

/** Decoded pixels for a hash, or null when it isn't a valid blurhash. */
export function hashToPixels(hash: string, width: number, height: number): Uint8ClampedArray | null {
  try {
    return decode(hash, width, height);
  } catch {
    return null;
  }
}

const cache = new Map<string, string>();

/** A data URL for a received photo's placeholder, cached by hash. */
export function blurHashUrl(hash: string, width?: number, height?: number): string | null {
  const key = hash + '|' + (width || 0) + 'x' + (height || 0);
  const hit = cache.get(key);
  if (hit) return hit;
  const size = placeholderSize(width, height);
  const pixels = hashToPixels(hash, size.width, size.height);
  if (!pixels) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const image = ctx.createImageData(size.width, size.height);
    image.data.set(pixels);
    ctx.putImageData(image, 0, 0);
    const url = canvas.toDataURL('image/png');
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
    cache.set(key, url);
    return url;
  } catch {
    return null;
  }
}
