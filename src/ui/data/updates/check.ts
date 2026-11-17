/* Looks for a newer Beacon. Every release carries `update.json` from `scripts/package.sh`, and GitHub serves the newest stable release's copy at a fixed address. */

import { isReleaseVersion, isSha256Hex } from '../../../engine/validate';
import { fmt, S } from '../../strings';
import { config } from '../config';
import { SOURCE_URL } from '../guides';
import { http } from '../http';
import { dbg } from '../log';
import { appVersion, hasServiceWorker } from '../platform';
import { emit } from '../store/events';

export interface UpdateInfo {
  version: string;
  tag: string;
  zip: string;
  size: number;
  sha256: string;
  security: boolean;
}

export const RELEASES_URL = SOURCE_URL + '/releases';
const UPDATE_JSON_URL = RELEASES_URL + '/latest/download/update.json';
const MAX_UPDATE_JSON_BYTES = 4096;
export const MAX_ZIP_BYTES = 10 * 1024 * 1024;
export const CHECK_EVERY_MS = 24 * 3600000;
const RETRY_AFTER_MS = 3600000;

let available: UpdateInfo | null = null;
let checking: Promise<UpdateInfo | null> | null = null;

/** The newer release found by the last check, if any. */
export function availableUpdate(): UpdateInfo | null {
  return available;
}

export function isChecking(): boolean {
  return !!checking;
}

/** `update.json` comes from the network: anything that isn't exactly the expected shape is ignored. */
export function parseUpdateInfo(raw: unknown): UpdateInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isReleaseVersion(r.version)) return null;
  const version = r.version;
  if (r.tag !== 'v' + version || r.zip !== 'signal4kaios-' + version + '.zip') return null;
  if (typeof r.size !== 'number' || !Number.isInteger(r.size) || r.size <= 0 || r.size > MAX_ZIP_BYTES) return null;
  if (!isSha256Hex(r.sha256)) return null;
  return { version, tag: 'v' + version, zip: 'signal4kaios-' + version + '.zip', size: r.size, sha256: r.sha256, security: r.security === true };
}

/** Compares two `major.minor.patch` versions: negative, zero, or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The release in `info` if it's newer than `installed`, else null. */
export function newerThan(info: UpdateInfo | null, installed: string): UpdateInfo | null {
  if (!info || !isReleaseVersion(installed)) return null;
  return compareVersions(info.version, installed) > 0 ? info : null;
}

function unavailable(): Error {
  const err = new Error('no update information');
  err.name = 'UpdateUnavailable';
  return err;
}

function fetchUpdateInfo(): Promise<UpdateInfo> {
  return http.external('GET', UPDATE_JSON_URL, { maxBytes: MAX_UPDATE_JSON_BYTES, timeout: 15000 }).then(
    (body) => {
      let raw: unknown = null;
      try {
        raw = JSON.parse(new TextDecoder().decode(body));
      } catch {
        throw unavailable();
      }
      const info = parseUpdateInfo(raw);
      if (!info) {
        dbg('update: update.json has an unexpected shape');
        throw unavailable();
      }
      return info;
    },
    (e: { kind?: string; status?: number; message?: string }) => {
      dbg('update: check failed ' + (e.kind || '') + ' ' + (e.status || '') + ' ' + (e.message || ''));
      throw e && e.kind === 'http' ? unavailable() : e;
    }
  );
}

/** Ask for the newest release now. Resolves to it when it's newer than this install, else null; rejects when the check failed. */
export function checkForUpdate(now = Date.now()): Promise<UpdateInfo | null> {
  if (checking) return checking;
  const run = Promise.all([fetchUpdateInfo(), appVersion()]).then(
    ([info, installed]) => {
      config.set({ updateCheckedAt: now });
      available = newerThan(info, installed);
      dbg('update: latest ' + info.version + ', installed ' + (installed || '?') + (available ? ', update available' : ''));
      if (available) notifySecurityUpdate(available);
      return available;
    },
    (e) => {
      config.set({ updateCheckedAt: now - CHECK_EVERY_MS + RETRY_AFTER_MS });
      throw e;
    }
  );
  checking = run;
  emit('update');
  const done = () => {
    checking = null;
    emit('update');
  };
  run.then(done, done);
  return run;
}

/** The automatic check: at most once a day, and only while the setting is on. */
export function maybeCheckForUpdate(now = Date.now()): Promise<UpdateInfo | null> {
  if (!config.autoUpdateCheck()) return Promise.resolve(available);
  const last = config.updateCheckedAt();
  if (last && last <= now && now - last < CHECK_EVERY_MS) return Promise.resolve(available);
  return checkForUpdate(now).catch(() => available);
}

/** One system notification per security release, on top of the banner, so it's seen even when Beacon is rarely opened to the chat list. */
function notifySecurityUpdate(info: UpdateInfo): void {
  if (!info.security || config.updateNotified() === info.version || typeof Notification === 'undefined') return;
  config.set({ updateNotified: info.version });
  const title = S.updateSecurityTitle;
  const opts: NotificationOptions = { body: fmt(S.updateSecurityText, { version: info.version }), tag: 'beacon-update', icon: '/assets/icons/kaios_112.png', data: { convId: null } };
  if (hasServiceWorker() && navigator.serviceWorker) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, opts)).catch((e) => dbg('update: notification failed ' + (e && e.message)));
    return;
  }
  try {
    new Notification(title, opts);
  } catch (e: any) {
    dbg('update: notification failed ' + (e && e.message));
  }
}

/** Records the version that's running. Resolves to it when it's newer than the one that ran last, so the first launch after an update can say so. */
export function noteLaunchVersion(): Promise<string | null> {
  return appVersion().then((version) => {
    const last = config.lastRunVersion();
    if (!version || version === last) return null;
    config.set({ lastRunVersion: version });
    return last && isReleaseVersion(last) && isReleaseVersion(version) && compareVersions(version, last) > 0 ? version : null;
  });
}
