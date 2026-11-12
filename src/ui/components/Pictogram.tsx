/* Larger line drawings for empty screens and help, in the theme's text and accent colors. Each is a base outline and an accent detail on a 64x64 grid. */

const SHIELD = 'M32 6l20 8v14c0 14-9 23-20 28-11-5-20-14-20-28V14z';

const PICTOGRAMS: Record<string, [string, string]> = {
  welcome: ['M22 10h20v44H22zM29 47h6', 'M47 23a10 10 0 010 14M52 18a17 17 0 010 24M17 23a10 10 0 000 14M12 18a17 17 0 000 24'],
  link: ['M6 14h18v36H6zM40 14h18v36H40zM12 44h6M46 44h6', 'M27 30h10M33 26l4 4-4 4M44 20h10v10H44z'],
  chats: ['M8 10h34v22H22l-8 7v-7H8z', 'M46 22h10v20h-4v7l-8-7H30v-6'],
  archive: ['M8 12h48v10H8zM12 22v30h40V22', 'M26 32h12'],
  contacts: ['M30 12a9 9 0 100 18 9 9 0 000-18zM12 54c0-10 8-16 18-16s18 6 18 16', 'M51 12v12M45 18h12'],
  media: ['M8 14h48v36H8z', 'M8 42l14-14 10 10 8-8 16 16M42 22a3 3 0 100 6 3 3 0 000-6z'],
  blocked: ['M32 8a24 24 0 100 48 24 24 0 000-48z', 'M15 15l34 34'],
  lock: ['M16 28h32v26H16zM22 28v-8a10 10 0 0120 0v8', 'M32 38v6'],
  proxy: [SHIELD, 'M22 34h18M34 28l6 6-6 6'],
  safety: [SHIELD, 'M22 31l7 7 13-14'],
  keys: ['M18 6h28v52H18z', 'M26 18v.1M32 18v.1M38 18v.1M26 26v.1M32 26v.1M38 26v.1M26 34v.1M32 34v.1M38 34v.1M32 42v.1'],
  settings: ['M32 21a11 11 0 100 22 11 11 0 000-22z', 'M32 6v8M32 50v8M6 32h8M50 32h8M14 14l6 6M44 44l6 6M14 50l6-6M44 20l6-6'],
  bell: ['M16 44V30a16 16 0 0132 0v14l5 5H11zM27 55h10', 'M50 10a14 14 0 014 10M14 10a14 14 0 00-4 10'],
  limits: ['M8 18h14v28H8zM38 10h20v44H38zM45 47h6', 'M25 32h10M31 28l4 4-4 4'],
  trouble: ['M20 8h24v48H20zM29 50h6', 'M32 18v14M32 39v1'],
  search: ['M27 10a17 17 0 100 34 17 17 0 000-34z', 'M40 40l14 14'],
  code: ['M8 12h48v40H8z', 'M24 26l-6 6 6 6M40 26l6 6-6 6M35 22l-6 20'],
};

export function Pictogram(props: { name: string; class?: string }) {
  const p = PICTOGRAMS[props.name];
  if (!p) return null;
  return (
    <svg class={'pictogram' + (props.class ? ' ' + props.class : '')} viewBox="0 0 64 64" aria-hidden="true">
      <path class="pictogram-base" d={p[0]} />
      <path class="pictogram-accent" d={p[1]} />
    </svg>
  );
}
