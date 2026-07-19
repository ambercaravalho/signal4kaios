/* Minimal timestamped logger. Never log push endpoints, subscription keys, or
   auth credentials - only counts and coarse status. */

function ts(): string {
  return new Date().toISOString();
}

export const log = {
  info(msg: string): void {
    console.log(ts() + ' ' + msg);
  },
  warn(msg: string): void {
    console.warn(ts() + ' WARN ' + msg);
  },
  error(msg: string, err?: unknown): void {
    const detail = err instanceof Error ? err.message : err ? String(err) : '';
    console.error(ts() + ' ERROR ' + msg + (detail ? ' - ' + detail : ''));
  }
};

/* Redact all but the last few digits of a Signal number for logs. */
export function maskNumber(n: string): string {
  if (!n) return '(none)';
  return n.length <= 4 ? '***' : '***' + n.slice(-4);
}
