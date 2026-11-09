(function () {
  'use strict';

  /* Platform abstraction for KaiOS 3.0, 3.1, and 4.0 (Gecko 84 / 123 B2G APIs:
     navigator.b2g.*, WebActivity, ServiceWorker) with desktop browser fallbacks. */

  function b2g() {
    return (typeof navigator !== 'undefined' && navigator.b2g) || null;
  }

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

  /* Launch a Web Activity ("view" a url, "pick" an image, etc.) on KaiOS 3.0+, falling back to window.open on desktop. */
  function openActivity(name, data) {
    if (typeof WebActivity !== 'undefined') {
      try {
        var wa = new WebActivity(name, data);
        return wa.start();
      } catch (e) {
        return Promise.reject(e);
      }
    }
    if (name === 'view' && data && data.url && window.open) {
      window.open(data.url, '_blank');
      return Promise.resolve();
    }
    return Promise.reject(new Error('web activities unavailable'));
  }

  /* Get a device storage area ("pictures", "music", "videos", "sdcard") via navigator.b2g.getDeviceStorage. */
  function getDeviceStorage(kind) {
    var api = b2g();
    if (api && api.getDeviceStorage) {
      try { return api.getDeviceStorage(kind); } catch (e) { return null; }
    }
    return null;
  }

  /* Save a named blob to a device storage area. */
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

  var alarmQueue = Promise.resolve();

  /* Remove this app's pending alarms whose data.type matches. */
  function clearAlarms(am, type) {
    if (!am.getAll || !am.remove) return Promise.resolve();
    return fromRequest(am.getAll()).then(function (list) {
      (list || []).forEach(function (a) {
        if (a && a.data && a.data.type === type) am.remove(a.id);
      });
    });
  }

  /* Schedule a one-shot wake alarm on KaiOS 3.0+ via navigator.b2g.alarmManager, replacing any pending alarm of the same data.type: alarms outlive the page, so adding without removing piles them up. */
  function scheduleAlarm(date, data) {
    var api = b2g();
    var am = api && api.alarmManager;
    if (!am || !am.add) return Promise.reject(new Error('alarms unavailable'));
    var run = alarmQueue.then(function () {
      return clearAlarms(am, data && data.type)['catch'](function () {});
    }).then(function () {
      return fromRequest(am.add({ date: date, data: data, ignoreTimezone: false }));
    });
    alarmQueue = run['catch'](function () {});
    return run;
  }

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
