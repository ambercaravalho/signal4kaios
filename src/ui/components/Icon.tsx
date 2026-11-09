/* Small monochrome glyphs drawn in the current text color. */

const PATHS: Record<string, string> = {
  chevron: 'M9 6l6 6-6 6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  checks: 'M2 12.5l4.5 4.5L16 7.5M10.5 16.5l1 1L21 7.5',
  clock: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2',
  alert: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v6M12 16.5v.5',
  pin: 'M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 14v7',
  mute: 'M4 9h4l5-4v14l-5-4H4zM16 9l5 6M21 9l-5 6',
  timer: 'M12 5a8 8 0 100 16 8 8 0 000-16zM12 9v4M10 2h4',
  photo: 'M4 6h16v12H4zM4 15l5-5 4 4 3-3 4 4',
  mic: 'M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM6 11a6 6 0 0012 0M12 17v4',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  play: 'M8 5v14l11-7z',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 018 0v4',
  verified: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6zM8.5 12l2.5 2.5 4.5-5',
  person: 'M12 4a4 4 0 100 8 4 4 0 000-8zM4 21c0-4 4-6 8-6s8 2 8 6',
  group: 'M9 5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zM2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5M16 5.5a3 3 0 010 6M18 14.5c2.5.5 4 2.5 4 5.5',
  note: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
};

export function Icon(props: { name: keyof typeof PATHS | string; class?: string }) {
  const d = PATHS[props.name];
  if (!d) return null;
  return (
    <svg class={'icon' + (props.class ? ' ' + props.class : '')} viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
