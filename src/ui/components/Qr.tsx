import encodeQR from 'qr';
import decodeQR from 'qr/decode.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { router, useKeys, useSoftkeys } from '../app/router';
import { dbg } from '../data/log';
import { openActivity } from '../data/platform';
import { S } from '../strings';
import { Screen } from './Screen';
import { toast } from './Toast';

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** The QR modules for `data`: text as the qr library encodes it, or bytes as one byte-mode segment with no ECI header, as Signal's apps draw a safety number. */
export function qrGrid(data: string | Uint8Array, ecc: 'low' | 'medium' = 'medium'): boolean[][] {
  if (typeof data === 'string') return encodeQR(data, 'raw', { ecc, border: 2 });
  return encodeQR(latin1(data), 'raw', { ecc, border: 2, encoding: 'byte', textEncoder: () => data });
}

/** Decodes a QR code from RGBA pixels; `binary` reads byte segments as Latin-1, one character per byte, instead of UTF-8. */
export function decodeQrPixels(img: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }, binary = false): string | null {
  try {
    return decodeQR(img, binary ? { textDecoder: latin1 } : {});
  } catch {
    return null;
  }
}

/** A QR code drawn as one SVG path of dark modules, on a white quiet zone so phones can scan it in dark mode too. */
export function QrCode(props: { text?: string; bytes?: Uint8Array; ecc?: 'low' | 'medium' }) {
  const { d, size } = useMemo(() => {
    const grid = qrGrid(props.bytes || props.text || '', props.ecc);
    let path = '';
    for (let y = 0; y < grid.length; y++) {
      const row = grid[y];
      for (let x = 0; x < row.length; x++) if (row[x]) path += 'M' + x + ' ' + y + 'h1v1h-1z';
    }
    return { d: path, size: grid.length };
  }, [props.text, props.bytes, props.ecc]);
  return (
    <div class="qr">
      <svg viewBox={'0 0 ' + size + ' ' + size} shape-rendering="crispEdges" role="img">
        <rect width={size} height={size} fill="#ffffff" />
        <path d={d} fill="#000000" />
      </svg>
    </div>
  );
}

const MAX_FRAME = 360;

function decodeCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, binary: boolean): string | null {
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return decodeQrPixels({ width: img.width, height: img.height, data: img.data }, binary);
}

function drawScaled(src: CanvasImageSource, w: number, h: number, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
  const scale = Math.min(1, MAX_FRAME / Math.max(w, h));
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
}

function decodeQrBlob(blob: Blob, binary: boolean): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        drawScaled(img, img.width, img.height, canvas, ctx);
        resolve(decodeCanvas(canvas, ctx, binary));
      } catch (e) {
        reject(e);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('unreadable photo'));
    };
    img.src = url;
  });
}

/** Ask the system for a photo (camera or gallery) and decode a QR code from it. */
function pickQrPhoto(binary: boolean): Promise<string | null | undefined> {
  return openActivity('pick', { type: ['image/*'] }).then(
    (res) => (res && res.blob ? decodeQrBlob(res.blob, binary) : undefined),
    () => undefined
  );
}

function ScanScreen(props: { title: string; binary: boolean; resolve(v: string | undefined): void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<string>(S.loading);
  const finished = useRef(false);

  const finish = (v: string | undefined) => {
    if (finished.current) return;
    finished.current = true;
    router.pop();
    props.resolve(v);
  };

  const fromPhoto = () =>
    pickQrPhoto(props.binary).then((text) => {
      if (text) finish(text);
      else if (text === null) toast(S.noCodeFound);
    });

  useSoftkeys({ left: S.cancel, center: null, right: S.scanFromPhoto });
  useKeys((e) => {
    if (e.key === 'SoftLeft' || e.key === 'Backspace') finish(undefined);
    else if (e.key === 'SoftRight') fromPhoto();
    else return false;
    return true;
  });

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    const loop = () => {
      if (stopped) return;
      const v = video.current;
      if (v && v.readyState >= 2 && v.videoWidth) {
        drawScaled(v, v.videoWidth, v.videoHeight, canvas, ctx);
        const text = decodeCanvas(canvas, ctx, props.binary);
        if (text) {
          finish(text);
          return;
        }
      }
      timer = setTimeout(loop, 150);
    };

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: 'environment' } })
        .then((s) => {
          if (stopped) {
            s.getTracks().forEach((t) => t.stop());
            return;
          }
          stream = s;
          if (video.current) video.current.srcObject = s;
          setStatus(S.scanning);
          loop();
        })
        .catch((e) => {
          dbg('camera unavailable: ' + (e && e.message));
          setStatus(S.cameraUnavailable);
        });
    } else {
      setStatus(S.cameraUnavailable);
    }

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <Screen title={props.title} bodyClass="scan-body">
      <video ref={video} class="scan-video" autoplay muted playsInline />
      <div class="scan-frame" />
      <div class="scan-status">{status}</div>
    </Screen>
  );
}

/** Scan a QR code with the camera, or from a photo; resolves the decoded text, or undefined when cancelled. With `binary`, byte segments come back as Latin-1 (see `decodeQrPixels`). */
export function scanQr(title: string, opts: { binary?: boolean } = {}): Promise<string | undefined> {
  return new Promise((resolve) => router.push(ScanScreen, { title, binary: !!opts.binary, resolve }));
}
