/* Installs a saved update over Beacon through the community install service the phone already uses for OStore's Manual Install: api-daemon's Sideload service, Flipfull's bridge on the TCL Flip 4, or the appscmd daemon. Stock KaiOS lets only its own store install apps, so a phone with none of these gets OStore's manual steps instead. */

import { http } from '../http';
import { dbg } from '../log';

export type InstallerName = 'sideload' | 'flipfull' | 'appscmd';

export interface Installer {
  name: InstallerName;
  /** Install the ZIP at this absolute path over the app with the same origin. */
  install(path: string): Promise<void>;
}

export type Probe = () => Promise<Installer>;

/** Beacon's manifest `origin`; an install service must only ever be asked to replace this app. */
export const APP_ORIGIN = 'signal4kaios';

const API = 'http://127.0.0.1/api/v1/';
const SESSION_SCRIPTS = [API + 'shared/core.js', API + 'shared/session.js'];
const SIDELOAD_SCRIPT = API + 'sideload/service.js';
const FLIPFULL_SCRIPT = 'http://127.0.0.1/flipfull/bridge.js';
const APPSCMD_URL = 'http://127.0.0.1:5431/';
const PROBE_MS = 5000;
const MAX_REPLY_BYTES = 64 * 1024;

const scripts: Record<string, Promise<void>> = {};

/** SECURITY-REVIEW: loads only the fixed scripts above, which the phone's own system services serve on 127.0.0.1, and only when an update is being installed. */
function loadScript(src: string): Promise<void> {
  if (!scripts[src]) {
    scripts[src] = new Promise<void>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => {
        delete scripts[src];
        el.remove();
        reject(new Error('could not load ' + src));
      };
      document.head.appendChild(el);
    });
  }
  return scripts[src];
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(what + ' timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function pageGlobal<T>(name: string): T | undefined {
  return (window as unknown as Record<string, T | undefined>)[name];
}

interface DaemonSession {
  open(kind: string, host: string, token: string, state: Record<string, () => void>, reconnect: boolean): void;
}

interface SideloadService {
  install(path: string): Promise<unknown>;
}

/** api-daemon's Sideload service, on systems carrying the Sideload patch; it serves only apps granted the `sideload` permission. */
const sideload: Probe = async () => {
  const ext = navigator.b2g && navigator.b2g.externalapi;
  if (!ext || typeof ext.getToken !== 'function') throw new Error('externalapi unavailable');
  for (const src of SESSION_SCRIPTS) await loadScript(src);
  const libSession = pageGlobal<{ Session: new () => DaemonSession }>('lib_session');
  if (!libSession || !libSession.Session) throw new Error('lib_session missing');
  // SECURITY-REVIEW: the api-daemon token authenticates this app to the phone's system services; it is never logged.
  const token = await ext.getToken();
  const session = new libSession.Session();
  await new Promise<void>((resolve, reject) => {
    session.open(
      'websocket',
      '127.0.0.1',
      token,
      {
        onsessionconnected: () => resolve(),
        onsessiondisconnected: () => reject(new Error('session closed')),
        onsessionconnectionerror: () => reject(new Error('session error')),
      },
      true
    );
  });
  await loadScript(SIDELOAD_SCRIPT);
  const lib = pageGlobal<{ Sideload: { get(s: DaemonSession): Promise<SideloadService> } }>('lib_sideload');
  if (!lib || !lib.Sideload) throw new Error('lib_sideload missing');
  const service = await lib.Sideload.get(session);
  return { name: 'sideload', install: (path) => service.install(path).then(() => undefined) };
};

interface FlipfullBridge {
  run(...words: string[]): Promise<unknown>;
}

/** The origin Flipfull read from a staged ZIP's manifest. */
export function stagedOrigin(reply: unknown): string {
  const line = String(reply || '')
    .split('\n')
    .find((l) => l.indexOf('origin\t') === 0);
  return line ? line.slice('origin\t'.length).trim() : '';
}

/** Flipfull's bridge on the TCL Flip 4: it stages the ZIP, reports the app it contains, then installs that app. */
const flipfull: Probe = async () => {
  for (const src of SESSION_SCRIPTS.concat(FLIPFULL_SCRIPT)) await loadScript(src);
  const bridge = pageGlobal<FlipfullBridge>('FlipfullBridge');
  if (!bridge || typeof bridge.run !== 'function') throw new Error('FlipfullBridge missing');
  await bridge.run('installed');
  return {
    name: 'flipfull',
    install: async (path) => {
      const origin = stagedOrigin(await bridge.run('stage-file', path));
      if (origin !== APP_ORIGIN) throw new Error('flipfull staged ' + (origin || 'an unknown app'));
      await bridge.run('install', origin, 'sdcard');
    },
  };
};

/** The appscmd daemon's replies are `{ code, msg, data }`, with `code` 0 on success. */
export function appscmdReply(body: Uint8Array): unknown {
  let reply: { code?: unknown; msg?: unknown; data?: unknown } | null = null;
  try {
    reply = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error('appscmd: unreadable reply');
  }
  if (!reply || reply.code !== 0) throw new Error('appscmd: ' + (reply && typeof reply.msg === 'string' ? reply.msg.slice(0, 200) : 'failed'));
  return reply.data;
}

function appscmdRequest(path: string, body?: unknown): Promise<unknown> {
  const opts = body === undefined ? { maxBytes: MAX_REPLY_BYTES, timeout: 120000 } : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, maxBytes: MAX_REPLY_BYTES, timeout: 120000 };
  return http.external(body === undefined ? 'GET' : 'POST', APPSCMD_URL + path, opts).then(appscmdReply);
}

/** The local appscmd daemon some phones run on port 5431. */
const appscmd: Probe = async () => {
  await appscmdRequest('list');
  return { name: 'appscmd', install: (path) => appscmdRequest('install', { content: path }).then(() => undefined) };
};

export const PROBES: Probe[] = [sideload, flipfull, appscmd];

/** The first install service in `probes` order that answers; they're asked all at once, so a phone with none waits only `timeoutMs`. */
export function pickInstaller(probes: Probe[], timeoutMs = PROBE_MS): Promise<Installer | null> {
  const tries = probes.map((probe) => {
    let attempt: Promise<Installer>;
    try {
      attempt = probe();
    } catch (e) {
      attempt = Promise.reject(e);
    }
    return withTimeout(attempt, timeoutMs, 'install service').then(
      (installer) => installer,
      (e: any) => {
        dbg('update: install service unavailable: ' + (e && e.message));
        return null;
      }
    );
  });
  return Promise.all(tries).then((found) => found.find((i): i is Installer => !!i) || null);
}

let found: Promise<Installer | null> | null = null;

/** The phone's install service, looked up once per launch. */
export function detectInstaller(): Promise<Installer | null> {
  if (!found) {
    found = pickInstaller(PROBES).then((installer) => {
      dbg('update: install service ' + (installer ? installer.name : 'none'));
      if (!installer) found = null;
      return installer;
    });
  }
  return found;
}
