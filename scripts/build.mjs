// Bundle the app (src/ui/main.tsx) into src/app/build/app.js and app.css for KaiOS 3.0+ (Gecko 84).
import { readFile } from 'node:fs/promises';
import * as esbuild from 'esbuild';

// The newest emoji release the KaiOS 3.x system emoji font can draw; newer ones show as empty boxes.
const MAX_EMOJI_VERSION = 12.1;

/* unicode-emoji-json's grouped file is ~420 KB with names and metadata; the picker needs only each group's emoji, so trim it while bundling. */
const slimEmoji = {
  name: 'slim-emoji',
  setup(build) {
    build.onLoad({ filter: /unicode-emoji-json[\\/]data-by-group\.json$/ }, async (args) => {
      const groups = JSON.parse(await readFile(args.path, 'utf8'));
      const slim = groups.map((g) => ({
        name: g.name,
        slug: g.slug,
        emojis: g.emojis.filter((e) => parseFloat(e.emoji_version) <= MAX_EMOJI_VERSION).map((e) => ({ emoji: e.emoji, emoji_version: e.emoji_version })),
      }));
      return { contents: JSON.stringify(slim), loader: 'json' };
    });
  },
};

await esbuild.build({
  entryPoints: ['src/ui/main.tsx'],
  outfile: 'src/app/build/app.js',
  bundle: true,
  format: 'iife',
  target: 'firefox84',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minifySyntax: true,
  minifyWhitespace: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  logOverride: { 'empty-import-meta': 'silent' },
  plugins: [slimEmoji],
  logLevel: 'info',
});
