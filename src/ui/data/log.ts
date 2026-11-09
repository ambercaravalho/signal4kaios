/* In-memory debug log shown in Settings > Debug. Callers must never pass keys, passwords, or provisioning codes. */

const MAX_LINES = 300;
const lines: string[] = [];

function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => (n < 10 ? '0' : '') + n;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function dbg(msg: string, data?: unknown): void {
  let line = stamp(Date.now()) + '  ' + msg;
  if (data !== undefined) {
    try {
      line += ' ' + JSON.stringify(data).slice(0, 300);
    } catch {
      // circular or unserializable: keep the message only
    }
  }
  lines.push(line);
  if (lines.length > MAX_LINES) lines.shift();
}

export function logLines(): string[] {
  return lines.slice();
}

/** The log with phone numbers, account IDs, and long opaque tokens shortened, for sharing outside the app. */
export function redactedLog(): string {
  return lines
    .map((l) =>
      l
        .replace(/\+\d{6,15}/g, (m) => '+…' + m.slice(-2))
        .replace(/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '$1-…')
        .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, '[…]')
    )
    .join('\n');
}
