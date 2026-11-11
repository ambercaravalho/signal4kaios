/* Link previews for messages we send, ported from Signal-Desktop's linkPreviewFetch.preload.ts: the page is fetched straight from the phone (as Desktop does without a user proxy), only its first 1000 KB is read, and the title, description, image, and date come from its Open Graph tags. */

import { toBase64 } from '../../engine/bytes';
import { linksIn, shouldPreviewHref } from '../../engine/services/link-previews';
import { fitGeometry, scaleToJpeg } from './image-scale';

const MAX_HTML_BYTES = 1000 * 1024;
const MAX_IMAGE_BYTES = 1024 * 1024;
const MIN_CONTENT_LENGTH = 8;
const MAX_CONTENT_TYPE_LENGTH = 100;
const MAX_TEXT = 300;
const TIMEOUT_MS = 15000;
const MAX_DATE = new Date(3000, 0, 1).valueOf();
const IMAGE_TYPES = ['image/gif', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/jpeg', 'image/png', 'image/webp'];
const SCALED_EDGE = 800;
const USER_AGENT = 'WhatsApp/2';

export interface PreviewResponse {
  status: number;
  /** The URL after redirects. */
  url: string;
  header(name: string): string | null;
  text?: string;
  bytes?: Uint8Array;
}

/** Fetches `url` as text (cut at `maxBytes`) or as bytes (rejecting past `maxBytes`). */
export type PreviewFetch = (url: string, as: 'text' | 'bytes', maxBytes: number, timeoutMs: number) => Promise<PreviewResponse>;

/** The parts of a parsed page that previews read; `DOMParser` provides them in the app. */
export interface PreviewDocument {
  title: string;
  meta(attr: 'property' | 'name', key: string): string | null;
  link(rel: string): string | null;
}

export interface PreviewImage {
  data: Uint8Array;
  contentType: string;
}

export interface FetchedPreview {
  url: string;
  title: string;
  description?: string;
  date?: number;
  image?: PreviewImage;
}

export interface PreviewDeps {
  fetch: PreviewFetch;
  parse(html: string): PreviewDocument;
  scale(image: PreviewImage): Promise<PreviewImage>;
}

/** The link a draft would get a preview for: the first safe one, only with the setting on and only for a plain text message. */
export function previewCandidate(draft: string, opts: { enabled: boolean; plainText: boolean }): string {
  if (!opts.enabled || !opts.plainText) return '';
  return linksIn(draft).find(shouldPreviewHref) || '';
}

function contentType(header: string | null): string {
  if (!header || header.length > MAX_CONTENT_TYPE_LENGTH) return '';
  return header.split(';')[0].trim().toLowerCase();
}

function contentLength(header: string | null): number {
  return header && /^\d{1,10}$/.test(header) ? parseInt(header, 10) : Infinity;
}

function isInline(header: string | null): boolean {
  return !header || header.split(';', 1)[0].trim().toLowerCase() === 'inline';
}

function resolve(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function clip(s: string | null | undefined): string {
  return (s || '').trim().slice(0, MAX_TEXT);
}

function lastPathComponent(url: string): string {
  try {
    const path = new URL(url).pathname;
    return path.slice(path.lastIndexOf('/') + 1);
  } catch {
    return url;
  }
}

/** Desktop's parseMetadata: Open Graph first, then the page's own title, description, and icons. */
export function parseMetadata(doc: PreviewDocument, href: string): { title: string; description: string; imageHref: string | null; date?: number } | null {
  const og = (keys: string[]) => {
    for (const k of keys) {
      const v = (doc.meta('property', k) || '').trim();
      if (v) return v;
    }
    return '';
  };
  const title = clip(og(['og:title']) || doc.title);
  if (!title) return null;
  const description = clip(og(['og:description']) || doc.meta('name', 'description'));
  let rawImage = og(['og:image', 'og:image:url']);
  for (const rel of ['apple-touch-icon', 'apple-touch-icon-precomposed', 'shortcut icon', 'icon']) {
    if (rawImage) break;
    rawImage = (doc.link(rel) || '').trim();
  }
  const imageHref = rawImage ? resolve(rawImage, href) : null;
  const rawDate = og(['og:modified_time', 'article:modified_time', 'og:published_time', 'article:published_time']);
  const parsed = rawDate ? Date.parse(rawDate) : NaN;
  return { title, description, imageHref, date: parsed > 0 && parsed < MAX_DATE ? parsed : undefined };
}

async function fetchImage(href: string, deps: PreviewDeps): Promise<PreviewImage | null> {
  if (!shouldPreviewHref(href)) return null;
  let res: PreviewResponse;
  try {
    res = await deps.fetch(href, 'bytes', MAX_IMAGE_BYTES, TIMEOUT_MS);
  } catch {
    return null;
  }
  return imageFrom(res, deps);
}

async function imageFrom(res: PreviewResponse, deps: PreviewDeps): Promise<PreviewImage | null> {
  if (res.status < 200 || res.status >= 300 || !shouldPreviewHref(res.url)) return null;
  const type = contentType(res.header('Content-Type'));
  if (IMAGE_TYPES.indexOf(type) < 0 || contentLength(res.header('Content-Length')) < MIN_CONTENT_LENGTH) return null;
  const data = res.bytes;
  if (!data || data.length < MIN_CONTENT_LENGTH || data.length > MAX_IMAGE_BYTES) return null;
  if (type === 'image/gif') return { data, contentType: type };
  try {
    return await deps.scale({ data, contentType: type });
  } catch {
    return null;
  }
}

/** A preview for `href`, or null when the page can't be fetched or has no title. */
export async function fetchLinkPreview(href: string, deps: PreviewDeps = appDeps): Promise<FetchedPreview | null> {
  if (!shouldPreviewHref(href)) return null;
  let res: PreviewResponse;
  try {
    res = await deps.fetch(href, 'text', MAX_HTML_BYTES, TIMEOUT_MS);
  } catch {
    return null;
  }
  if (res.status < 200 || res.status >= 300 || !shouldPreviewHref(res.url)) return null;
  if (!isInline(res.header('Content-Disposition')) || contentLength(res.header('Content-Length')) < MIN_CONTENT_LENGTH) return null;
  const type = contentType(res.header('Content-Type'));
  if (type !== 'text/html') {
    if (IMAGE_TYPES.indexOf(type) < 0) return null;
    const image = await fetchImage(res.url, deps);
    return image ? { url: href, title: clip(lastPathComponent(res.url)) || href, image } : null;
  }
  const meta = parseMetadata(deps.parse((res.text || '').slice(0, MAX_HTML_BYTES)), res.url);
  if (!meta) return null;
  const image = meta.imageHref ? await fetchImage(meta.imageHref, deps) : null;
  const out: FetchedPreview = { url: href, title: meta.title };
  if (meta.description) out.description = meta.description;
  if (meta.date) out.date = meta.date;
  if (image) out.image = image;
  return out;
}

/* Gecko's XHR follows redirects itself, so only where it ends up can be checked (`responseURL`). */
const xhrFetch: PreviewFetch = (url, as, maxBytes, timeoutMs) =>
  new Promise((resolvePromise, reject) => {
    let xhr: XMLHttpRequest;
    try {
      xhr = new (XMLHttpRequest as any)({ mozSystem: true });
    } catch {
      xhr = new XMLHttpRequest();
    }
    xhr.open('GET', url, true);
    xhr.timeout = timeoutMs;
    xhr.responseType = as === 'text' ? 'text' : 'arraybuffer';
    xhr.setRequestHeader('Accept', as === 'text' ? 'text/html,application/xhtml+xml' : 'image/*');
    try {
      xhr.setRequestHeader('User-Agent', USER_AGENT);
    } catch {
      // not settable here
    }
    const done = (text?: string) =>
      resolvePromise({
        status: xhr.status,
        url: xhr.responseURL || url,
        header: (n) => xhr.getResponseHeader(n),
        text: as === 'text' ? (text !== undefined ? text : xhr.responseText) : undefined,
        bytes: as === 'bytes' && xhr.response ? new Uint8Array(xhr.response) : undefined,
      });
    xhr.onprogress = (e) => {
      if (e.loaded <= maxBytes) return;
      xhr.onload = xhr.onerror = xhr.ontimeout = null;
      const partial = as === 'text' ? xhr.responseText : undefined;
      xhr.abort();
      if (as === 'text') done(partial);
      else reject(new Error('too large'));
    };
    xhr.onload = () => done();
    xhr.onerror = () => reject(new Error('network'));
    xhr.ontimeout = () => reject(new Error('timeout'));
    xhr.send();
  });

function domParse(html: string): PreviewDocument {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const attr = (sel: string, name: string) => {
    const el = doc.querySelector(sel);
    return el ? el.getAttribute(name) : null;
  };
  const quoted = (v: string) => '"' + v.replace(/["\\]/g, '\\$&') + '"';
  return {
    title: doc.title || '',
    meta: (a, key) => attr('meta[' + a + '=' + quoted(key) + ']', 'content'),
    link: (rel) => attr('link[rel=' + quoted(rel) + ']', 'href'),
  };
}

/** Desktop scales preview images down; this keeps the longest edge at 800 px as JPEG. */
function canvasScale(image: PreviewImage): Promise<PreviewImage> {
  const blob = new Blob([image.data as BlobPart], { type: image.contentType });
  return scaleToJpeg(blob, (w, h) => fitGeometry(w, h, SCALED_EDGE)).then((data) => ({ data, contentType: 'image/jpeg' }));
}

const appDeps: PreviewDeps = { fetch: xhrFetch, parse: domParse, scale: canvasScale };

export function imageDataUri(image: PreviewImage): string {
  return 'data:' + image.contentType + ';base64,' + toBase64(image.data);
}
