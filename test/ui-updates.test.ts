import './ui-env';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { config } from '../src/ui/data/config';
import { availableUpdate, checkForUpdate, compareVersions, CHECK_EVERY_MS, maybeCheckForUpdate, newerThan, noteLaunchVersion, parseUpdateInfo, type UpdateInfo } from '../src/ui/data/updates/check';
import { candidateName, downloadUpdate, saveUpdate, zipUrl } from '../src/ui/data/updates/download';
import { appscmdReply, type Installer, pickInstaller, stagedOrigin } from '../src/ui/data/updates/install';
import { friendlyError } from '../src/ui/errors';
import { S } from '../src/ui/strings';

const INSTALLED = '2.10.9';
const UPDATE_JSON = 'https://github.com/ambercaravalho/signal4kaios/releases/latest/download/update.json';

type Reply = { status: number; body: Uint8Array | string };
const routes: Record<string, () => Reply> = {};
const requested: string[] = [];

/** Serves `routes` to the app's XHRs; anything else is a 404. */
class FakeXhr {
  status = 0;
  response: ArrayBuffer | null = null;
  responseText = '';
  responseType = '';
  upload = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onprogress: ((e: { loaded: number }) => void) | null = null;
  private url = '';
  open(_method: string, url: string): void {
    this.url = url;
  }
  setRequestHeader(): void {}
  getResponseHeader(): null {
    return null;
  }
  abort(): void {}
  send(): void {
    requested.push(this.url);
    setTimeout(() => {
      const route = routes[this.url];
      const reply = route ? route() : { status: 404, body: '' };
      const bytes = typeof reply.body === 'string' ? new TextEncoder().encode(reply.body) : reply.body;
      this.status = reply.status;
      this.responseText = new TextDecoder().decode(bytes);
      this.response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      if (this.onprogress) this.onprogress({ loaded: bytes.length });
      if (this.onload) this.onload();
    }, 0);
  }
}
(globalThis as any).XMLHttpRequest = FakeXhr;
routes['/manifest.webmanifest'] = () => ({ status: 200, body: JSON.stringify({ b2g_features: { version: INSTALLED } }) });

const ZIP = new TextEncoder().encode('PK fake release zip');
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function release(version: string, extra: Partial<UpdateInfo> = {}): Record<string, unknown> {
  return { version, tag: 'v' + version, zip: 'signal4kaios-' + version + '.zip', size: ZIP.length, sha256: sha256(ZIP), security: false, ...extra };
}

function serveUpdateJson(body: unknown, status = 200): void {
  routes[UPDATE_JSON] = () => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

describe('update.json', () => {
  it('accepts exactly the shape package.sh writes', () => {
    const info = parseUpdateInfo(release('2.11.0', { security: true }));
    assert.deepEqual(info, { version: '2.11.0', tag: 'v2.11.0', zip: 'signal4kaios-2.11.0.zip', size: ZIP.length, sha256: sha256(ZIP), security: true });
  });

  it('rejects anything else', () => {
    const bad: unknown[] = [
      null,
      'v2.11.0',
      [release('2.11.0')],
      release('2.11.0-rc1'),
      release('2.11'),
      release('02.11.0'),
      release('2.11.0', { tag: 'v2.12.0' }),
      release('2.11.0', { zip: '../../signal4kaios-2.11.0.zip' }),
      release('2.11.0', { zip: 'other-2.11.0.zip' }),
      release('2.11.0', { sha256: 'abc' }),
      release('2.11.0', { sha256: sha256(ZIP).toUpperCase() }),
      release('2.11.0', { size: 0 }),
      release('2.11.0', { size: 1.5 }),
      release('2.11.0', { size: 11 * 1024 * 1024 }),
    ];
    for (const raw of bad) assert.equal(parseUpdateInfo(raw), null, JSON.stringify(raw));
  });

  it('counts only `true` as a security release', () => {
    assert.equal(parseUpdateInfo(release('2.11.0', { security: 'yes' as any }))!.security, false);
  });
});

describe('version comparison', () => {
  it('compares each part as a number', () => {
    assert.ok(compareVersions('2.10.10', '2.10.9') > 0);
    assert.ok(compareVersions('2.10.9', '2.11.0') < 0);
    assert.ok(compareVersions('3.0.0', '2.99.99') > 0);
    assert.equal(compareVersions('2.10.9', '2.10.9'), 0);
  });

  it('offers only a newer release, and nothing when the installed version is unknown', () => {
    const info = parseUpdateInfo(release('2.11.0'))!;
    assert.equal(newerThan(info, '2.10.9'), info);
    assert.equal(newerThan(info, '2.11.0'), null);
    assert.equal(newerThan(info, '2.12.0'), null);
    assert.equal(newerThan(info, ''), null);
  });
});

describe('checking for updates', () => {
  beforeEach(() => {
    config.clear();
    requested.length = 0;
  });

  it('finds a newer release and remembers when it checked', async () => {
    serveUpdateJson(release('2.11.0'));
    const info = await checkForUpdate(1000);
    assert.equal(info && info.version, '2.11.0');
    assert.equal(availableUpdate(), info);
    assert.equal(config.updateCheckedAt(), 1000);
  });

  it('finds nothing when the latest release is the one installed', async () => {
    serveUpdateJson(release(INSTALLED));
    assert.equal(await checkForUpdate(), null);
    assert.equal(availableUpdate(), null);
  });

  it('says the update couldn’t be found, not that the phone was unlinked, when GitHub refuses', async () => {
    serveUpdateJson('', 403);
    const now = 10 * CHECK_EVERY_MS;
    await assert.rejects(checkForUpdate(now), (e: Error) => e.name === 'UpdateUnavailable');
    assert.equal(friendlyError(Object.assign(new Error('x'), { name: 'UpdateUnavailable' })), S.errUpdateUnavailable);
    assert.equal(config.updateCheckedAt(), now - CHECK_EVERY_MS + 3600000, 'tries again in an hour');
  });

  it('ignores a malformed update.json', async () => {
    serveUpdateJson('{"version": "9.9.9"');
    await assert.rejects(checkForUpdate(), (e: Error) => e.name === 'UpdateUnavailable');
  });

  it('checks automatically at most once a day, and never with the setting off', async () => {
    serveUpdateJson(release(INSTALLED));
    const now = 5 * CHECK_EVERY_MS;
    config.set({ updateCheckedAt: now - 1000 });
    await maybeCheckForUpdate(now);
    assert.ok(!requested.includes(UPDATE_JSON));

    config.set({ updateCheckedAt: now - CHECK_EVERY_MS });
    await maybeCheckForUpdate(now);
    assert.ok(requested.includes(UPDATE_JSON));

    requested.length = 0;
    config.set({ updateCheckedAt: 0, autoUpdateCheck: false });
    await maybeCheckForUpdate(now);
    assert.deepEqual(requested, []);
    assert.equal(config.autoUpdateCheck(), false);
  });

  it('swallows a failed automatic check', async () => {
    serveUpdateJson('', 500);
    await maybeCheckForUpdate(CHECK_EVERY_MS * 3);
  });
});

describe('downloading an update', () => {
  const info = parseUpdateInfo(release('2.11.0'))!;

  it('returns the ZIP when it matches update.json', async () => {
    routes[zipUrl(info)] = () => ({ status: 200, body: ZIP });
    const seen: number[] = [];
    const bytes = await downloadUpdate(info, (f) => seen.push(f));
    assert.deepEqual(bytes, ZIP);
    assert.deepEqual(seen, [1]);
    assert.equal(zipUrl(info), 'https://github.com/ambercaravalho/signal4kaios/releases/download/v2.11.0/signal4kaios-2.11.0.zip');
  });

  it('refuses a ZIP whose checksum doesn’t match', async () => {
    const tampered = ZIP.slice();
    tampered[0] ^= 1;
    routes[zipUrl(info)] = () => ({ status: 200, body: tampered });
    await assert.rejects(downloadUpdate(info), (e: Error) => e.name === 'UpdateCorrupt');
  });

  it('refuses a ZIP larger than update.json says', async () => {
    routes[zipUrl(info)] = () => ({ status: 200, body: new Uint8Array(ZIP.length + 1) });
    await assert.rejects(downloadUpdate(info));
  });

  it('saves under the next free name, since existing files can’t be replaced', async () => {
    const tried: string[] = [];
    const save = (_kind: string, _blob: Blob, name: string) => {
      tried.push(name);
      return tried.length < 3 ? Promise.reject(new Error('exists')) : Promise.resolve('/sdcard/' + name);
    };
    const saved = await saveUpdate(ZIP, info, save);
    assert.deepEqual(tried, ['signal4kaios-2.11.0.zip', 'signal4kaios-2.11.0-2.zip', 'signal4kaios-2.11.0-3.zip']);
    assert.deepEqual(saved, { name: 'signal4kaios-2.11.0-3.zip', path: '/sdcard/signal4kaios-2.11.0-3.zip' });
    assert.equal(candidateName(info, 1), 'signal4kaios-2.11.0.zip');
  });

  it('gives up with a storage error when the phone has no storage', async () => {
    const save = () => Promise.reject(new Error('storage unavailable'));
    await assert.rejects(saveUpdate(ZIP, info, save), (e: Error) => e.name === 'UpdateStorage');
  });
});

describe('the install service', () => {
  const fake = (name: Installer['name']): Installer => ({ name, install: () => Promise.resolve() });

  it('uses the first service in order that answers', async () => {
    const picked = await pickInstaller([() => Promise.reject(new Error('missing')), () => Promise.resolve(fake('flipfull')), () => Promise.resolve(fake('appscmd'))]);
    assert.equal(picked && picked.name, 'flipfull');
  });

  it('waits out a service that never answers, and falls back to the manual steps when none does', async () => {
    const never = () => new Promise<Installer>(() => {});
    const thrown = () => {
      throw new Error('no bridge');
    };
    assert.equal(await pickInstaller([never, thrown], 20), null);
    const picked = await pickInstaller([never, () => Promise.resolve(fake('appscmd'))], 20);
    assert.equal(picked && picked.name, 'appscmd');
  });

  it('reads the origin Flipfull staged', () => {
    assert.equal(stagedOrigin('name\tBeacon\norigin\tsignal4kaios\nversion\t2.11.0'), 'signal4kaios');
    assert.equal(stagedOrigin('name\tBeacon'), '');
    assert.equal(stagedOrigin(undefined), '');
  });

  it('reads appscmd replies, failing on a non-zero code', () => {
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    assert.deepEqual(appscmdReply(enc({ code: 0, data: ['a'] })), ['a']);
    assert.throws(() => appscmdReply(enc({ code: 1, msg: 'bad zip' })), /bad zip/);
    assert.throws(() => appscmdReply(new TextEncoder().encode('<html>')), /unreadable/);
  });
});

describe('the first launch after an update', () => {
  beforeEach(() => config.clear());

  it('says so once, and not on a first install', async () => {
    assert.equal(await noteLaunchVersion(), null);
    config.set({ lastRunVersion: '2.10.8' });
    assert.equal(await noteLaunchVersion(), INSTALLED);
    assert.equal(await noteLaunchVersion(), null);
    assert.equal(config.lastRunVersion(), INSTALLED);
  });
});
