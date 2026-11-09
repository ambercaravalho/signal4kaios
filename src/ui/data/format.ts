/* Dates, durations, names, and safety numbers as the UI shows them. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n: number): string {
  return (n < 10 ? '0' : '') + n;
}

function clock(d: Date): string {
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** Chat list time: "14:32" today, "10 Jul" this year, "07/24" before. */
export function fmtTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return clock(d);
  if (d.getFullYear() === now.getFullYear()) return d.getDate() + ' ' + MONTHS[d.getMonth()];
  return pad2(d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(-2);
}

/** Time of day only, for bubbles that sit under a day divider. */
export function fmtClock(ts: number): string {
  return ts ? clock(new Date(ts)) : '';
}

/** Message time: "14:32" today, "Yesterday 14:32", "10 Jul, 14:32" this year, "10 Jul 2024, 14:32" before. */
export function fmtMsgTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return clock(d);
  const yest = new Date(now.getTime());
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday ' + clock(d);
  let date = d.getDate() + ' ' + MONTHS[d.getMonth()];
  if (d.getFullYear() !== now.getFullYear()) date += ' ' + d.getFullYear();
  return date + ', ' + clock(d);
}

/** Day divider in a chat: "Today", "Yesterday", "10 Jul", or "10 Jul 2024". */
export function fmtDay(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yest = new Date(now.getTime());
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '');
}

/** Full date and time with seconds, for message details. */
export function fmtTimeFull(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' + clock(d) + ':' + pad2(d.getSeconds());
}

/** Compact countdown: "45s", "5m", "1h", "2d", "1w". */
export function fmtDuration(secs: number): string {
  secs = Math.max(0, Math.round(secs));
  if (secs < 60) return secs + 's';
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + 'm';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h';
  const days = Math.round(hrs / 24);
  if (days < 7) return days + 'd';
  return Math.round(days / 7) + 'w';
}

export function fmtBytes(n: number): string {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Signal's disappearing-message choices. */
export const EXPIRE_OPTIONS: Array<{ secs: number; label: string }> = [
  { secs: 0, label: 'Off' },
  { secs: 30, label: '30 seconds' },
  { secs: 300, label: '5 minutes' },
  { secs: 3600, label: '1 hour' },
  { secs: 28800, label: '8 hours' },
  { secs: 86400, label: '1 day' },
  { secs: 604800, label: '1 week' },
  { secs: 2419200, label: '4 weeks' },
];

export function expireLabel(secs: number): string {
  const opt = EXPIRE_OPTIONS.find((o) => o.secs === secs);
  if (opt) return opt.label;
  return secs ? fmtDuration(secs) : 'Off';
}

export function initials(name: string): string {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  let out = Array.from(parts[0])[0] || '';
  if (parts.length > 1) out += Array.from(parts[parts.length - 1])[0] || '';
  return out.toUpperCase();
}

/** A 60-digit safety number as 12 groups of 5. */
export function formatSafetyNumber(sn: string): string[] {
  const clean = String(sn || '').replace(/\s+/g, '');
  const out: string[] = [];
  for (let i = 0; i < clean.length; i += 5) out.push(clean.slice(i, i + 5));
  return out;
}
