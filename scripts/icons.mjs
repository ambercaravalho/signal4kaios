// Renders the launcher icons from src/app/assets/icons/beacon.svg. Run `npm run icons` after editing the SVG and commit the PNGs.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'assets', 'icons');
const svg = readFileSync(join(dir, 'beacon.svg'), 'utf8');

for (const size of [56, 112]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(join(dir, `kaios_${size}.png`), png);
  console.log(`kaios_${size}.png  ${png.length} bytes`);
}
