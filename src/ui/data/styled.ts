/* Signal text formatting. Formatting travels as body ranges `{ start, length, style }` in UTF-16 units, which match JS string indices. */

export type TextStyle = 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE' | 'SPOILER';

export interface StyleRange {
  start: number;
  length: number;
  style: string;
}

const STYLES: Record<string, true> = { BOLD: true, ITALIC: true, STRIKETHROUGH: true, MONOSPACE: true, SPOILER: true };

/* Longer openers come first so ** wins over *. */
const MARKERS: Array<{ o: string; s: TextStyle }> = [
  { o: '||', s: 'SPOILER' },
  { o: '**', s: 'BOLD' },
  { o: '*', s: 'ITALIC' },
  { o: '~', s: 'STRIKETHROUGH' },
  { o: '`', s: 'MONOSPACE' },
];

function findClose(text: string, close: string, from: number): number {
  let i = from;
  while (i <= text.length - close.length) {
    if (text.charAt(i) === '\\') {
      i += 2;
      continue;
    }
    if (text.startsWith(close, i)) return i;
    i += 1;
  }
  return -1;
}

function stripEscapes(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

/** Turn typed markers (`**bold**`, `*italic*`, `~strike~`, `` `mono` ``, `||spoiler||`) into a plain body plus style ranges. Unmatched markers stay as text. */
export function parseStyledMarkdown(text: string): { body: string; styles: StyleRange[] } {
  const styles: StyleRange[] = [];
  if (!text) return { body: '', styles };
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '\\' && i + 1 < text.length) {
      out += text.charAt(i + 1);
      i += 2;
      continue;
    }
    let matched = false;
    for (const mk of MARKERS) {
      if (!text.startsWith(mk.o, i)) continue;
      const innerStart = i + mk.o.length;
      const closeIdx = findClose(text, mk.o, innerStart);
      if (closeIdx < 0 || closeIdx === innerStart) continue;
      const inner = stripEscapes(text.slice(innerStart, closeIdx));
      styles.push({ start: out.length, length: inner.length, style: mk.s });
      out += inner;
      i = closeIdx + mk.o.length;
      matched = true;
      break;
    }
    if (!matched) {
      out += ch;
      i += 1;
    }
  }
  return { body: out, styles };
}

/** Someone picked with Mention; `name` is what was inserted after the "@". */
export interface PickedMention {
  name: string;
  uuid: string;
}

export interface MentionRange {
  start: number;
  length: number;
  uuid: string;
}

/** Find each picked "@name" still in the body and replace it with the U+FFFC placeholder Signal sends, moving style ranges to match. A mention edited away is simply not found. */
export function encodeMentions(body: string, styles: StyleRange[], picked: PickedMention[]): { body: string; styles: StyleRange[]; mentions: MentionRange[] } {
  const hits: Array<{ start: number; end: number; uuid: string }> = [];
  const byLength = picked.filter((p) => p.name && p.uuid).sort((a, b) => b.name.length - a.name.length);
  for (const p of byLength) {
    const token = '@' + p.name;
    for (let i = body.indexOf(token); i >= 0; i = body.indexOf(token, i + token.length)) {
      const end = i + token.length;
      if (!hits.some((h) => i < h.end && end > h.start)) hits.push({ start: i, end, uuid: p.uuid });
    }
  }
  if (!hits.length) return { body, styles, mentions: [] };
  hits.sort((a, b) => a.start - b.start);

  const move = (pos: number, isEnd: boolean): number => {
    let shift = 0;
    for (const h of hits) {
      if (pos >= h.end) shift += h.end - h.start - 1;
      else if (pos > h.start) return h.start - shift + (isEnd ? 1 : 0);
      else break;
    }
    return pos - shift;
  };

  let out = '';
  let last = 0;
  const mentions: MentionRange[] = [];
  for (const h of hits) {
    out += body.slice(last, h.start);
    mentions.push({ start: out.length, length: 1, uuid: h.uuid });
    out += '\uFFFC';
    last = h.end;
  }
  out += body.slice(last);
  const moved: StyleRange[] = [];
  for (const s of styles) {
    const start = move(s.start, false);
    const end = move(s.start + s.length, true);
    if (end > start) moved.push({ start, length: end - start, style: s.style });
  }
  return { body: out, styles: moved, mentions };
}

export interface Segment {
  text: string;
  styles: string[];
}

/** Split text on every range boundary so overlapping styles each apply to their part. */
export function styleSegments(text: string, ranges: StyleRange[] | undefined): Segment[] {
  text = text || '';
  const valid = (ranges || [])
    .map((r) => {
      const a = Math.max(0, r.start | 0);
      return { a, b: Math.min(text.length, a + (r.length | 0)), style: String(r.style || '').toUpperCase() };
    })
    .filter((r) => r.b > r.a && STYLES[r.style]);
  if (!valid.length) return [{ text, styles: [] }];
  const pts = new Set<number>([0, text.length]);
  for (const r of valid) {
    pts.add(r.a);
    pts.add(r.b);
  }
  const bounds = Array.from(pts).sort((x, y) => x - y);
  const out: Segment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    if (b <= a) continue;
    const styles: string[] = [];
    for (const r of valid) if (r.a <= a && r.b >= b && styles.indexOf(r.style) < 0) styles.push(r.style);
    out.push({ text: text.slice(a, b), styles });
  }
  return out;
}

/* One emoji (astral glyph, flag pair, or common BMP symbol) with its VS16, skin tone, and ZWJ sequence. Surrogate ranges, not \p{}, so Gecko 84 needs no Unicode property support. */
const EMOJI_RE =
  /(?:\uD83C[\uDDE6-\uDDFF]){2}|(?:[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u00A9\u00AE\u203C\u2049\u2122\u2139\u2194-\u21AA\u231A\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u27BF\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299])(?:\uFE0F)?(?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D(?:[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF])(?:\uFE0F)?(?:\uD83C[\uDFFB-\uDFFF])?)*/g;

/** Text and emoji runs, so emoji can be drawn a little larger than the text around them. */
export function emojiRuns(text: string): Array<{ text: string; emoji: boolean }> {
  const out: Array<{ text: string; emoji: boolean }> = [];
  if (!text) return out;
  EMOJI_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = EMOJI_RE.exec(text)) !== null) {
    if (!m[0]) {
      EMOJI_RE.lastIndex += 1;
      continue;
    }
    if (m.index > last) out.push({ text: text.slice(last, m.index), emoji: false });
    out.push({ text: m[0], emoji: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), emoji: false });
  return out;
}

/** True when the text is only one to three emoji, which Signal shows large without a bubble. */
export function isJumboEmoji(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  const runs = emojiRuns(t);
  return runs.length > 0 && runs.length <= 3 && runs.every((r) => r.emoji);
}

/** No modifier, then the Fitzpatrick modifiers U+1F3FB to U+1F3FF, light to dark. */
export const SKIN_TONES = ['', '\uD83C\uDFFB', '\uD83C\uDFFC', '\uD83C\uDFFD', '\uD83C\uDFFE', '\uD83C\uDFFF'];

/** The emoji with a skin tone modifier after its first code point and without a trailing VS16; ZWJ sequences are left alone. */
export function withSkinTone(emoji: string, tone: string): string {
  if (!tone || !emoji || emoji.indexOf('\u200D') >= 0) return emoji;
  const first = String.fromCodePoint(emoji.codePointAt(0)!);
  let rest = emoji.slice(first.length);
  if (rest.charAt(rest.length - 1) === '\uFE0F') rest = rest.slice(0, -1);
  return first + tone + rest;
}

const URL_RE = /https?:\/\/[^\s]+/g;

/** Text and http(s) link runs, with trailing sentence punctuation left out of the link. */
export function linkRuns(text: string): Array<{ text: string; url?: string }> {
  const out: Array<{ text: string; url?: string }> = [];
  if (!text) return out;
  URL_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    const url = m[0].replace(/[.,;:!?)]+$/, '');
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: url, url });
    last = m.index + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export function extractUrls(text: string): string[] {
  return linkRuns(text)
    .filter((r) => r.url)
    .map((r) => r.url as string);
}
