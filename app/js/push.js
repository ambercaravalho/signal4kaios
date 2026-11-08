(function () {
  'use strict';

  /* Background wake & notification manager (`App.push`) for KaiOS 3.0 / 3.1 / 4.0.
     Ensures notification permission is granted and subscribes the ServiceWorker (`sw.js`)
     to KaiOS `alarm` system messages so background wake alarms can reconnect the Signal WebSocket
     and drain queued messages. */

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
