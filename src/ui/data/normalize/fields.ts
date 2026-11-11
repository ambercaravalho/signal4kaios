/* Readers for untrusted frame fields. */



export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : 0;
  return isFinite(n) ? n : 0;
}

export function strings(list: unknown, max: number): string[] {
  return Array.isArray(list) ? list.map(str).filter(Boolean).slice(0, max) : [];
}
