(function () {
  'use strict';

  /* Platform abstraction over the KaiOS B2G APIs that differ between 2.5 and
     3.0/4.0. Each helper feature-detects the newer 3.0/4.0 shape first
     (navigator.b2g.*, WebActivity, ServiceWorker) and falls back to the 2.5
     shape (MozActivity, navigator.getDeviceStorage, navigator.mozAlarms).

     Everything here returns a Promise so callers get one consistent contract
     regardless of whether the underlying API resolves via a Promise (3.0/4.0)
     or a DOMRequest (2.5). Nothing throws on desktop / an unsupported build —
     callers get a rejected Promise they can handle. */

  function b2g() {
    return (typeof navigator !== 'undefined' && navigator.b2g) || null;
  }

  /* Wrap a value that may be a DOMRequest (2.5) or a Promise (3.0/4.0) in a
     single Promise. `this.result` / `this.error` are the DOMRequest surface. */
  function fromRequest(reqOrPromise) {
    if (reqOrPromise && typeof reqOrPromise.then === 'function') {
      return reqOrPromise;
    }
    return new Promise(function (resolve, reject) {
      var req = reqOrPromise;
      if (!req) {
        reject(new Error('no request'));
        return;
      }
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('request failed')); };
    });
  }

  /* Launch a Web Activity ("view" a url, "pick" an image, etc.).
     - 3.0/4.0: new WebActivity(name, data).start() -> Promise
     - 2.5:     new MozActivity({ name, data })     -> DOMRequest
     - desktop: for a "view" url, fall back to window.open. */
  function openActivity(name, data) {
    if (typeof WebActivity !== 'undefined') {
      try {
        var wa = new WebActivity(name, data);
        return wa.start();
      } catch (e) {
        return Promise.reject(e);
      }
    }
    if (typeof MozActivity !== 'undefined') {
      try {
        return fromRequest(new MozActivity({ name: name, data: data }));
      } catch (e2) {
        return Promise.reject(e2);
      }
    }
    if (name === 'view' && data && data.url && window.open) {
      window.open(data.url, '_blank');
      return Promise.resolve();
    }
    return Promise.reject(new Error('web activities unavailable'));
  }

  /* Get a device storage area ("pictures", "music", "videos", "sdcard").
     Returns the storage object (not a Promise) or null when unavailable, so
     callers can null-check before adding a file. */
  function getDeviceStorage(kind) {
    var api = b2g();
    if (api && api.getDeviceStorage) {
      try { return api.getDeviceStorage(kind); } catch (e) { return null; }
    }
    if (navigator.getDeviceStorage) {
      try { return navigator.getDeviceStorage(kind); } catch (e2) { return null; }
    }
    return null;
  }

  /* Save a named blob to a device storage area. Resolves with the stored name.
     Normalizes the DOMRequest (2.5) vs Promise (3.0/4.0) return of addNamed. */
  function addNamed(storage, blob, name) {
    if (!storage || !storage.addNamed) {
      return Promise.reject(new Error('storage unavailable'));
    }
    try {
      return fromRequest(storage.addNamed(blob, name));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /* Schedule a one-shot wake alarm.
     - 3.0/4.0: navigator.b2g.alarmManager.add({ date, data, ignoreTimezone })
     - 2.5:     navigator.mozAlarms.add(date, 'honorTimezone', data)
     Resolves regardless of platform; rejects if no alarm API exists. */
  function scheduleAlarm(date, data) {
    var api = b2g();
    if (api && api.alarmManager && api.alarmManager.add) {
      try {
        return fromRequest(api.alarmManager.add({
          date: date,
          data: data,
          ignoreTimezone: false
        }));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    if (navigator.mozAlarms && navigator.mozAlarms.add) {
      try {
        return fromRequest(navigator.mozAlarms.add(date, 'honorTimezone', data));
      } catch (e2) {
        return Promise.reject(e2);
      }
    }
    return Promise.reject(new Error('alarms unavailable'));
  }

  /* True wherever a ServiceWorker is available: 3.0/3.1/4.0, and 2.5 once the
     'serviceworker' permission is granted (it's what exposes
     navigator.serviceWorker there). False on desktop/simulator without one. */
  function hasServiceWorker() {
    return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  }

  App.platform = {
    openActivity: openActivity,
    getDeviceStorage: getDeviceStorage,
    addNamed: addNamed,
    scheduleAlarm: scheduleAlarm,
    hasServiceWorker: hasServiceWorker
  };
})();
