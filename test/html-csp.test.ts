import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function passes(html: string): boolean {
  const file = join(mkdtempSync(join(tmpdir(), 'csp-')), 'index.html');
  writeFileSync(file, html);
  return spawnSync('sh', ['scripts/check-html-csp.sh', file], { stdio: 'ignore' }).status === 0;
}

describe('the page’s CSP check', () => {
  it('passes the shipped page', () => {
    assert.equal(spawnSync('sh', ['scripts/check-html-csp.sh', 'src/app/index.html'], { stdio: 'ignore' }).status, 0);
  });

  it('fails inline scripts, styles, handlers, and javascript: URLs', () => {
    assert.equal(passes('<link rel="stylesheet" href="a.css">\n<script src="build/app.js"></script>\n'), true);
    assert.equal(passes('<script>boot()</script>\n'), false);
    assert.equal(passes('<style>body{}</style>\n'), false);
    assert.equal(passes('<div style="color:red"></div>\n'), false);
    assert.equal(passes('<body onload="boot()">\n'), false);
    assert.equal(passes('<a href="javascript:void(0)">x</a>\n'), false);
  });
});

describe('the manifest', () => {
  it('only asks to add files to the phone’s storage, since Beacon never reads or lists them', () => {
    const perms = JSON.parse(readFileSync('src/app/manifest.webmanifest', 'utf8')).b2g_features.permissions;
    const storage = Object.keys(perms).filter((k) => k.indexOf('device-storage:') === 0);
    assert.ok(storage.length > 0);
    for (const k of storage) assert.equal(perms[k].access, 'createonly', k);
  });
});
