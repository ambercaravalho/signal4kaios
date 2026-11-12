import { dbg } from './log';
import { hasServiceWorker } from './platform';

const RELOADED_KEY = 's4k.wasmReload';
const ACTIVATE_TIMEOUT_MS = 5000;
const POLL_MS = 200;

function settled(reg: ServiceWorkerRegistration): boolean {
  return !reg.installing && !reg.waiting && !!reg.active && reg.active.state === 'activated';
}

function whenSettled(reg: ServiceWorkerRegistration): Promise<void> {
  const deadline = Date.now() + ACTIVATE_TIMEOUT_MS;
  return new Promise((resolve) => {
    const check = () => {
      if (settled(reg) || Date.now() >= deadline) resolve();
      else setTimeout(check, POLL_MS);
    };
    check();
  });
}

function markReloaded(): boolean {
  try {
    if (sessionStorage.getItem(RELOADED_KEY)) return false;
    sessionStorage.setItem(RELOADED_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/** On KaiOS 4.0 only pages served through `sw.js` may compile WebAssembly, and the first launch after an install or update can load before the newest one takes control. Resolves false when reloading won't help, so the caller can show the error instead. */
export function reloadUnderServiceWorker(): Promise<boolean> {
  if (!hasServiceWorker() || !markReloaded()) return Promise.resolve(false);
  return navigator.serviceWorker
    .register('/sw.js')
    .then((reg) =>
      reg
        .update()
        .catch(() => {})
        .then(() => whenSettled(reg))
    )
    .then(
      () => {
        dbg('boot: WebAssembly blocked, reloading under the service worker');
        location.reload();
        return true;
      },
      (e) => {
        dbg('boot: service worker unavailable ' + (e && e.message));
        return false;
      }
    );
}
