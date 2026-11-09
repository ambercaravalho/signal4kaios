(function () {
  'use strict';

  /* Background wake & notification manager (`App.push`) for KaiOS 3.0 / 3.1 / 4.0.
     1. Ensures notification permission is granted.
     2. Subscribes the ServiceWorker (`sw.js`) to KaiOS `alarm` system messages.
     3. Caches the active account's WebSocket coordinates in Cache Storage (`s4k-push`) so when
        a wake alarm fires while the app window is completely closed, `sw.js` can check Signal's
        server for queued messages (`GET /v1/messages` or WebSocket probe), re-arm the next wake alarm,
        and show a notification ("New Signal message") that opens the app to decrypt and display it. */

  var PUSH_CACHE = 's4k-push';
  var WAKE_CFG_KEY = '/__s4k_wake_cfg';

  function supported() {
    return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  }

  function ensurePermission() {
    if (typeof Notification === 'undefined') return Promise.resolve('unsupported');
    if (Notification.permission === 'granted') return Promise.resolve('granted');
    if (Notification.permission === 'denied') return Promise.resolve('denied');
    try {
      var r = Notification.requestPermission();
      if (r && typeof r.then === 'function') return r;
    } catch (e) { /* callback-only form */ }
    return Promise.resolve(Notification.permission || 'default');
  }

  function saveWakeCfg() {
    if (typeof caches === 'undefined' || !App.config.isConfigured()) {
      return Promise.resolve();
    }
    var loginId = (App.config.aci() || App.config.number()) + '.' + App.config.deviceId();
    // SECURITY-REVIEW: credentials cached in origin-isolated Cache Storage solely for ServiceWorker background wake.
    var cfg = {
      serverUrl: App.config.serverUrl(),
      wsUrl: App.config.wsUrl(),
      login: loginId,
      password: App.config.deviceToken(),
      number: App.config.number()
    };
    return caches.open(PUSH_CACHE).then(function (cache) {
      return cache.put(WAKE_CFG_KEY, new Response(JSON.stringify(cfg), {
        headers: { 'Content-Type': 'application/json' }
      }));
    })['catch'](function () {});
  }

  function subscribeSystemMessages(reg) {
    if (!reg || !reg.systemMessageManager) return Promise.resolve();
    try {
      return reg.systemMessageManager.subscribe('alarm').then(function () {
        App.util.dbg('push: system alarm message subscribed');
      })['catch'](function (e) {
        App.util.dbg('push: subscribe(alarm) failed — ' + (e && e.message));
      });
    } catch (e) {
      return Promise.resolve();
    }
  }

  function sync() {
    if (!supported() || !App.config.isConfigured()) {
      return Promise.resolve();
    }
    return ensurePermission().then(function (perm) {
      App.util.dbg('push: notification permission = ' + perm);
      return saveWakeCfg();
    }).then(function () {
      return navigator.serviceWorker.ready;
    }).then(function (reg) {
      return subscribeSystemMessages(reg);
    })['catch'](function (e) {
      App.util.dbg('push: background wake setup failed — ' + (e && e.message));
    });
  }

  App.push = {
    supported: supported,
    sync: sync
  };
})();
