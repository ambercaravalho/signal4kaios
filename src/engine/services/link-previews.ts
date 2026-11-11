/* Link preview checks, ported from Signal-Desktop's LinkPreview.shouldPreviewHref, isLinkSneaky, and getValidLinkPreviews. */

const EXCLUDED_DOMAINS = ['debuglogs.org', 'example', 'example.com', 'example.net', 'example.org', 'invalid', 'localhost', 'onion', 'test'];
const DIRECTIONAL_OVERRIDES = /[\u202c\u202d\u202e]/;
const UNICODE_DRAWING = /[\u2500-\u25FF]/;
const VALID_URI_CHARACTERS = /^[%:/?#[\]@!$&'()*+,;=A-Za-z0-9\-._~]*$/;
const MAX_HREF_LENGTH = 2 ** 12;
const TRAILING_PUNCTUATION = /[.,;:!?)]+$/;
const MAX_PREVIEW_TEXT = 300;

function parseUrl(href: string): URL | null {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

/** Signal-Desktop's isLinkSneaky, minus the mixed-script check: hostnames in punycode (`xn--`) are treated as sneaky because Gecko 84 has no domainToUnicode. */
function isLinkSneaky(href: string, url: URL): boolean {
  if (href.length > MAX_HREF_LENGTH || UNICODE_DRAWING.test(href)) return true;
  if (url.username || url.password || !url.hostname) return true;
  if (url.hostname.length > 2048 || url.hostname.indexOf('%') >= 0) return true;
  const labels = url.hostname.split('.');
  if (labels.length < 2 || labels.some((l) => !l || l.indexOf('xn--') === 0)) return true;
  const start = href.indexOf('/', url.protocol.length + 4);
  return !VALID_URI_CHARACTERS.test(start < 0 ? '' : href.slice(start));
}

export function shouldPreviewHref(href: string): boolean {
  const url = parseUrl(href);
  if (!url || url.protocol !== 'https:') return false;
  const host = url.hostname;
  if (EXCLUDED_DOMAINS.some((d) => host === d || host.endsWith('.' + d))) return false;
  return !isLinkSneaky(href, url);
}

/** Links in a message body by the same rule the app uses to make them openable (src/ui/data/styled.ts linkRuns). */
export function linksIn(body: string): string[] {
  if (!body || DIRECTIONAL_OVERRIDES.test(body)) return [];
  return (body.match(/https?:\/\/[^\s]+/g) || []).map((u) => u.replace(TRAILING_PUNCTUATION, ''));
}

/** A preview is shown only for a safe https link that appears in the message's own text. */
export function isValidLinkPreview(url: string, body: string): boolean {
  return !!url && shouldPreviewHref(url) && linksIn(body).indexOf(url) >= 0;
}

export interface OutgoingPreviewFields {
  url: string;
  title: string;
  description?: string;
  date?: bigint;
}

/** The text of a preview we send, like Signal-Desktop's getLinkPreviewForSend: only for a safe link in the text, never alongside attachments, and never without a title. */
export function previewFieldsForSend(p: { url: string; title: string; description?: string; date?: number } | undefined, body: string, hasAttachments: boolean): OutgoingPreviewFields | null {
  if (!p || hasAttachments || !isValidLinkPreview(p.url, body)) return null;
  const title = (p.title || '').trim().slice(0, MAX_PREVIEW_TEXT);
  if (!title) return null;
  const out: OutgoingPreviewFields = { url: p.url, title };
  const description = (p.description || '').trim().slice(0, MAX_PREVIEW_TEXT);
  if (description) out.description = description;
  if (typeof p.date === 'number' && p.date > 0 && isFinite(p.date)) out.date = BigInt(Math.floor(p.date));
  return out;
}
