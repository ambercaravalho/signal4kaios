import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { GUIDES, SOURCE_URL } from '../src/ui/data/guides';

const DOCS = SOURCE_URL + '/blob/main/docs/';

/** The anchors GitHub gives a Markdown file's headings. */
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const line of markdown.replace(/^```[\s\S]*?^```/gm, '').split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = m[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/ /g, '-');
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

describe('in-app guides', () => {
  it('point at this repository’s docs on main', () => {
    for (const [topic, g] of Object.entries(GUIDES)) {
      assert.ok(g.url === SOURCE_URL || g.url.startsWith(DOCS), `${topic}: ${g.url}`);
      assert.ok(g.title.length > 0, topic);
    }
  });

  it('link only to files and headings that exist', () => {
    for (const [topic, g] of Object.entries(GUIDES)) {
      if (g.url === SOURCE_URL) continue;
      const [path, anchor] = g.url.slice(DOCS.length).split('#');
      const markdown = readFileSync('docs/' + path, 'utf8');
      if (anchor) assert.ok(anchors(markdown).has(anchor), `${topic}: docs/${path} has no heading for #${anchor}`);
    }
  });

  it('reads anchors the way GitHub does', () => {
    const a = anchors('# 2. Link your Signal account\n## Chat settings, groups, and safety numbers\n## Keys\n## Keys\n```\n# not a heading\n```');
    assert.deepEqual([...a], ['2-link-your-signal-account', 'chat-settings-groups-and-safety-numbers', 'keys', 'keys-1']);
  });
});
