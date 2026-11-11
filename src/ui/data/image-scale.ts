/* Canvas image scaling shared by link previews and the profile photo. */

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

export function drawToCanvas(img: HTMLImageElement, g: DrawGeometry): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = g.width;
  canvas.height = g.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
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
export async function scaleToJpeg(blob: Blob, layout: (w: number, h: number) => DrawGeometry, quality = 0.8): Promise<Uint8Array> {
  const img = await loadImage(blob);
  return canvasJpeg(drawToCanvas(img, layout(img.naturalWidth, img.naturalHeight)), quality);
}
