/* KaiOS 3.0+ system APIs (navigator.b2g, WebActivity, ServiceWorker), with desktop-browser fallbacks. */

function b2g(): B2gNavigator | null {
  return (typeof navigator !== 'undefined' && navigator.b2g) || null;
}

function fromRequest<T>(req: B2gDomRequest<T> | Promise<T> | null | undefined): Promise<T> {
  if (req && typeof (req as Promise<T>).then === 'function') return req as Promise<T>;
  return new Promise((resolve, reject) => {
    const r = req as B2gDomRequest<T> | null;
    if (!r) {
      reject(new Error('no request'));
      return;
    }
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('request failed'));
  });
}

/** Start a Web Activity ("view" a URL, "pick" a photo, "share" a file), falling back to window.open for "view" on desktop. */
export function openActivity(name: string, data: any): Promise<any> {
  if (typeof WebActivity !== 'undefined') {
    try {
      return new WebActivity(name, data).start();
    } catch (e) {
      return Promise.reject(e);
    }
  }
  if (name === 'view' && data && data.url && typeof window.open === 'function') {
    window.open(data.url, '_blank');
    return Promise.resolve();
  }
  return Promise.reject(new Error('web activities unavailable'));
}

export function openUrl(url: string): Promise<void> {
  return openActivity('view', { type: 'url', url });
}

/** Save a blob to "pictures", "music", "videos", or "sdcard". */
export function saveToDevice(kind: string, blob: Blob, name: string): Promise<unknown> {
  const api = b2g();
  let storage: B2gDeviceStorage | null = null;
  try {
    storage = api && api.getDeviceStorage ? api.getDeviceStorage(kind) : null;
  } catch {
    storage = null;
  }
  if (!storage) return Promise.reject(new Error('storage unavailable'));
  try {
    return fromRequest(storage.addNamed(blob, name));
  } catch (e) {
    return Promise.reject(e);
  }
}

let alarmQueue: Promise<unknown> = Promise.resolve();

function clearAlarms(am: B2gAlarmManager, type: string | undefined): Promise<void> {
  if (!am.getAll || !am.remove) return Promise.resolve();
  return fromRequest(am.getAll()).then((list) => {
    for (const a of list || []) if (a && a.data && a.data.type === type) am.remove!(a.id);
  });
}

/** Schedule a one-shot wake alarm, replacing any pending alarm of the same `data.type`: alarms outlive the page, so adding without removing piles them up. */
export function scheduleAlarm(date: Date, data: { type: string }): Promise<unknown> {
  const api = b2g();
  const am = api && api.alarmManager;
  if (!am || !am.add) return Promise.reject(new Error('alarms unavailable'));
  const run = alarmQueue
    .then(() => clearAlarms(am, data.type).catch(() => {}))
    .then(() => fromRequest(am.add({ date, data, ignoreTimezone: false })));
  alarmQueue = run.catch(() => {});
  return run;
}

export function hasServiceWorker(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/** Read the installed app version from the manifest. */
let versionPromise: Promise<string> | null = null;
export function appVersion(): Promise<string> {
  if (!versionPromise) {
    versionPromise = new Promise<string>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/manifest.webmanifest', true);
      xhr.onload = () => {
        try {
          const m = JSON.parse(xhr.responseText);
          resolve((m && m.b2g_features && m.b2g_features.version) || '');
        } catch {
          resolve('');
        }
      };
      xhr.onerror = () => resolve('');
      xhr.send();
    });
  }
  return versionPromise;
}
