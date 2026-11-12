// Bundle the app (src/ui/main.tsx) into src/app/build/app.js and app.css for KaiOS 3.0+ (Gecko 84), and the archive decoder into src/app/build/backup.js.
// `node scripts/build.mjs --analyze` also writes dist/meta.json and prints the largest inputs.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as esbuild from 'esbuild';

// The newest emoji release the KaiOS 3.x system emoji font can draw; newer ones show as empty boxes.
const MAX_EMOJI_VERSION = 12.1;
const analyze = process.argv.includes('--analyze');

/* unicode-emoji-json's grouped file is ~420 KB with names and metadata; the picker needs only each group's drawable emoji, so trim it while bundling. Emoji without a usable skin tone become plain strings; `Emoji.tsx` also reads the unslimmed file the tests bundle. */
const slimEmoji = {
  name: 'slim-emoji',
  setup(build) {
    build.onLoad({ filter: /unicode-emoji-json[\\/]data-by-group\.json$/ }, async (args) => {
      const groups = JSON.parse(await readFile(args.path, 'utf8'));
      const slim = groups.map((g) => ({
        name: g.name,
        slug: g.slug,
        emojis: g.emojis
          .filter((e) => parseFloat(e.emoji_version) <= MAX_EMOJI_VERSION)
          .map((e) => (e.skin_tone_support && parseFloat(e.skin_tone_support_unicode_version) <= MAX_EMOJI_VERSION ? { emoji: e.emoji, skin_tone_support: true } : e.emoji)),
      }));
      return { contents: JSON.stringify(slim), loader: 'json' };
    });
  },
};

const common = {
  bundle: true,
  format: 'iife',
  target: 'firefox84',
  minify: true,
  legalComments: 'none',
  metafile: analyze,
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: { wasi_snapshot_preview1: './src/engine/protocol/wasi.ts' },
  logOverride: { 'empty-import-meta': 'silent' },
  logLevel: 'info',
};

const result = await esbuild.build({
  ...common,
  entryPoints: ['src/ui/main.tsx'],
  outfile: 'src/app/build/app.js',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  plugins: [slimEmoji],
});

// The link-and-sync archive decoder (Backups codecs), loaded only while message history is imported.
await esbuild.build({ ...common, entryPoints: ['src/engine/services/history/bundle.ts'], outfile: 'src/app/build/backup.js', metafile: false });

if (analyze) {
  await mkdir('dist', { recursive: true });
  await writeFile('dist/meta.json', JSON.stringify(result.metafile));
  const inputs = Object.entries(result.metafile.outputs['src/app/build/app.js'].inputs)
    .map(([path, info]) => [path, info.bytesInOutput])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  for (const [path, bytes] of inputs) console.log(`${(bytes / 1024).toFixed(1).padStart(8)} KB  ${path}`);
}
