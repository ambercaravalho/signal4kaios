(function () {
  'use strict';

  /* Web Push client (App.push) — the phone side of background / closed-app
     notifications. It subscribes to the KaiOS push service and hands the
     resulting subscription to a "push bridge" server that watches signal-cli and
     turns incoming messages into pushes (see docs/push-bridge.md). The
     ServiceWorker (sw.js) does the actual notifying on the 'push' event, even
     when the app is closed.

     Only meaningful on KaiOS 3.0+ (ServiceWorker + Push API). On 2.5 every call
     resolves to a no-op / rejects cleanly. */

  function supported() {
    return typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator &&
      typeof window !== 'undefined' && 'PushManager' in window;
  }

  /* base64url VAPID public key -> Uint8Array for applicationServerKey. */
  function urlB64ToUint8Array(base64) {
    var padding = new Array((4 - (base64.length % 4)) % 4 + 1).join('=');
    var b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = window.atob(b64);
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  /* Cross-origin JSON POST to the bridge over mozSystem XHR (privileged apps
     bypass CORS for the request; the bridge is a separate host from the
     signal-cli server, so App.http — which is bound to serverUrl — can't be
     reused). */
  function bridgePost(path, body) {
    return new Promise(function (resolve, reject) {
      var base = App.config.pushBridgeUrl();
      if (!base) {
        reject(new Error('Push bridge URL is not set'));
        return;
      }
      var xhr;
      try {
        xhr = new XMLHttpRequest({ mozSystem: true });
      } catch (e) {
        xhr = new XMLHttpRequest();
      }
      xhr.open('POST', base + path, true);
      xhr.timeout = 15000;
      xhr.setRequestHeader('Content-Type', 'application/json');
      // SECURITY-REVIEW: bearer token for the push bridge; never logged.
      var token = App.config.pushBridgeToken();
      if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.responseText || '');
        } else {
          reject(new Error('Bridge HTTP ' + xhr.status));
        }
      };
      xhr.onerror = function () { reject(new Error('Bridge unreachable')); };
      xhr.ontimeout = function () { reject(new Error('Bridge timed out')); };
      xhr.send(JSON.stringify(body));
    });
  }

  /* Persist the bridge coordinates where the ServiceWorker can read them while
     the app is closed (Cache Storage is shared between page and worker). */
  function saveBridgeCfg() {
    if (typeof caches === 'undefined') return Promise.resolve();
    var cfg = {
      bridgeUrl: App.config.pushBridgeUrl(),
      token: App.config.pushBridgeToken(),
      number: App.config.number(),
      vapidKey: App.config.pushVapidKey()
    };
    return caches.open('s4k-push').then(function (cache) {
      return cache.put('/__s4k_push_cfg',
        new Response(JSON.stringify(cfg), {
          headers: { 'Content-Type': 'application/json' }
        }));
    })['catch'](function (e) {
      App.util.dbg('push: could not cache bridge cfg — ' + (e && e.message));
    });
  }

  function clearBridgeCfg() {
    if (typeof caches === 'undefined') return Promise.resolve();
    return caches.open('s4k-push').then(function (cache) {
      return cache['delete']('/__s4k_push_cfg');
    })['catch'](function () { return null; });
  }

  function subscribe(reg) {
    var opts = { userVisibleOnly: true };
    var key = App.config.pushVapidKey();
    if (key) {
      try {
        opts.applicationServerKey = urlB64ToUint8Array(key);
      } catch (e) {
        return Promise.reject(new Error('Invalid VAPID key: ' + e.message));
      }
    }
    return reg.pushManager.getSubscription().then(function (existing) {
      if (existing) return existing;
      return reg.pushManager.subscribe(opts);
    });
  }

  function registerWithBridge(sub) {
    return bridgePost('/v1/push/register', {
      number: App.config.number(),
      platform: 'kaios',
      subscription: sub.toJSON ? sub.toJSON() : sub
    });
  }

  /* Turn on background push: subscribe, cache bridge coordinates for the SW,
     register the subscription with the bridge, and persist the enabled flag.
     Resolves with the subscription endpoint host for the UI. */
  function enable() {
    if (!supported()) {
      return Promise.reject(new Error('Push is not supported on this device'));
    }
    if (!App.config.pushBridgeUrl()) {
      return Promise.reject(new Error('Set the push bridge URL first'));
    }
    return navigator.serviceWorker.ready.then(function (reg) {
      return subscribe(reg);
    }).then(function (sub) {
      return saveBridgeCfg().then(function () {
        return registerWithBridge(sub);
      }).then(function () {
        App.config.set({ pushEnabled: true });
        App.util.dbg('push: enabled (' + endpointHost(sub.endpoint) + ')');
        return endpointHost(sub.endpoint);
      });
    });
  }

  /* Turn off background push: unregister from the bridge, unsubscribe, clear
     cached coordinates and the enabled flag. Best-effort; always ends disabled. */
  function disable() {
    App.config.set({ pushEnabled: false });
    if (!supported()) return clearBridgeCfg();
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      if (!sub) return null;
      return bridgePost('/v1/push/unregister', {
        number: App.config.number(),
        endpoint: sub.endpoint
      })['catch'](function () { return null; }).then(function () {
        return sub.unsubscribe()['catch'](function () { return null; });
      });
    })['catch'](function () { return null; }).then(function () {
      return clearBridgeCfg();
    });
  }

  /* On boot, if push is enabled, make sure the current subscription is still
     registered with the bridge (endpoints can change across reboots/updates).
     Silent and best-effort — never blocks startup. */
  function sync() {
    if (!supported() || !App.config.pushEnabled() || !App.config.pushBridgeUrl()) {
      return Promise.resolve();
    }
    return navigator.serviceWorker.ready.then(function (reg) {
      return subscribe(reg);
    }).then(function (sub) {
      return saveBridgeCfg().then(function () {
        return registerWithBridge(sub);
      });
    })['catch'](function (e) {
      App.util.dbg('push: sync failed — ' + (e && e.message));
    });
  }

  function endpointHost(endpoint) {
    try {
      var a = document.createElement('a');
      a.href = endpoint;
      return a.protocol + '//' + a.host;
    } catch (e) {
      return 'push service';
    }
  }

  App.push = {
    supported: supported,
    enable: enable,
    disable: disable,
    sync: sync
  };
})();
