(function () {
  'use strict';

  /* Closed-app wake setup (`App.wake`). There is no server push in v2: instead `sw.js` wakes on KaiOS `alarm` system messages, briefly opens Signal's WebSocket to see whether messages are queued, and shows a "New Signal message" notification that opens the app to decrypt them. This module:
     1. Ensures notification permission is granted.
     2. Caches the active account's WebSocket URL and login in Cache Storage (`s4k-wake`) for that probe.
     3. Subscribes the ServiceWorker to `alarm` system messages. */

  var WAKE_CACHE = 's4k-wake';
  var WAKE_CFG_KEY = '/__s4k_wake_cfg';

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
      wsUrl: App.config.wsUrl(),
      login: loginId,
      password: App.config.deviceToken()
    };
    return caches.open(WAKE_CACHE).then(function (cache) {
      return cache.put(WAKE_CFG_KEY, new Response(JSON.stringify(cfg), {
        headers: { 'Content-Type': 'application/json' }
      }));
    })['catch'](function () {});
  }

  function subscribeSystemMessages(reg) {
    if (!reg || !reg.systemMessageManager) return Promise.resolve();
    try {
      return reg.systemMessageManager.subscribe('alarm').then(function () {
        App.util.dbg('wake: system alarm message subscribed');
      })['catch'](function (e) {
        App.util.dbg('wake: subscribe(alarm) failed — ' + (e && e.message));
      });
    } catch (e) {
      return Promise.resolve();
    }
  }

  function sync() {
    if (!App.platform.hasServiceWorker() || !App.config.isConfigured()) {
      return Promise.resolve();
    }
    return ensurePermission().then(function (perm) {
      App.util.dbg('wake: notification permission = ' + perm);
      return saveWakeCfg();
    }).then(function () {
      return navigator.serviceWorker.ready;
    }).then(function (reg) {
      return subscribeSystemMessages(reg);
    })['catch'](function (e) {
      App.util.dbg('wake: background wake setup failed — ' + (e && e.message));
    });
  }

  App.wake = {
    sync: sync
  };
})();
