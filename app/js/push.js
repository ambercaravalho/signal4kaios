(function () {
  'use strict';

  /* Web Push client (App.push) — the phone side of background / closed-app
     notifications. Push is ALWAYS ON with no user-facing options: on boot the
     app fetches the gateway's VAPID public key (GET /v1/push/vapid), subscribes
     to the KaiOS push service, and registers the subscription with the gateway
     (POST /v1/push/register) over App.http. The gateway holds the signal-cli
     receive stream open and turns incoming messages into pushes; the
     ServiceWorker (sw.js) shows the notification on the 'push' event, even when
     the app is fully closed.

     Works on every KaiOS with the Push API — 2.5 and 3.0/3.1/4.0 alike (the API
     is ServiceWorker-based on all of them). The one version difference is how the
     OS is told to cold-wake the worker for a push: 3.0+ needs a runtime
     systemMessageManager.subscribe('push') (see subscribeSystemMessages), while
     2.5 wires it purely through the manifest ('serviceworker'/'push' permissions
     and the 'push' message). On desktop/simulator without Push, every call
     resolves to a clean no-op. */

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

  /* Persist the coordinates the ServiceWorker needs while the app is closed
     (Cache Storage is shared between page and worker): the gateway base URL, the
     account number, the VAPID key (to re-subscribe), and — in 'token' auth mode
     — the token/param so the worker's own fetches can pass the reverse proxy.
     SECURITY-REVIEW: the receive token is a credential; it is cached only for
     the worker and never logged. */
  function savePushCfg(vapidKey) {
    if (typeof caches === 'undefined') return Promise.resolve();
    var cfg = {
      serverUrl: App.config.serverUrl(),
      number: App.config.number(),
      vapidKey: vapidKey || ''
    };
    if (App.config.authMode() === 'token') {
      cfg.tokenParam = App.config.tokenParam();
      cfg.token = App.config.receiveToken();
    }
    return caches.open('s4k-push').then(function (cache) {
      return cache.put('/__s4k_push_cfg',
        new Response(JSON.stringify(cfg), {
          headers: { 'Content-Type': 'application/json' }
        }));
    })['catch'](function (e) {
      App.util.dbg('push: could not cache push cfg — ' + (e && e.message));
    });
  }

  /* The VAPID key the app last subscribed with, so we can detect a change
     (e.g. the gateway going from keyless to VAPID-configured) and re-subscribe.
     KaiOS/Gecko doesn't reliably expose subscription.options, so we compare
     against this cached value instead. */
  function readCachedVapidKey() {
    if (typeof caches === 'undefined') return Promise.resolve('');
    return caches.open('s4k-push').then(function (cache) {
      return cache.match('/__s4k_push_cfg');
    }).then(function (res) {
      return res ? res.json() : null;
    }).then(function (cfg) {
      return (cfg && cfg.vapidKey) || '';
    })['catch'](function () { return ''; });
  }

  function subscribe(reg, vapidKey, forceResubscribe) {
    var opts = { userVisibleOnly: true };
    if (vapidKey) {
      try {
        opts.applicationServerKey = urlB64ToUint8Array(vapidKey);
      } catch (e) {
        return Promise.reject(new Error('Invalid VAPID key: ' + e.message));
      }
    }
    return reg.pushManager.getSubscription().then(function (existing) {
      if (existing && !forceResubscribe) return existing;
      if (!existing) return reg.pushManager.subscribe(opts);
      // Key changed: drop the stale subscription and make a fresh one so the
      // new applicationServerKey (or lack of one) actually takes effect.
      App.util.dbg('push: VAPID key changed, re-subscribing');
      return existing.unsubscribe()['catch'](function () { return null; })
        .then(function () { return reg.pushManager.subscribe(opts); });
    });
  }

  /* Make sure we're actually allowed to show notifications. On KaiOS a push is
     delivered but silently produces nothing if desktop-notification isn't
     granted. Privileged apps are usually auto-granted, but request explicitly so
     a 'default'/prompt state can't swallow every notification. */
  function ensurePermission() {
    if (typeof Notification === 'undefined') return Promise.resolve('unsupported');
    if (Notification.permission === 'granted') return Promise.resolve('granted');
    if (Notification.permission === 'denied') return Promise.resolve('denied');
    try {
      var r = Notification.requestPermission();
      if (r && typeof r.then === 'function') return r;
    } catch (e) { /* older callback-only form; fall through */ }
    return Promise.resolve(Notification.permission || 'default');
  }

  /* Read the breadcrumb sw.js writes on every 'push' event, so the in-app Debug
     log can show whether the ServiceWorker is actually receiving pushes on this
     device (there's no console on the phone). */
  function reportPushDebug() {
    if (typeof caches === 'undefined') return Promise.resolve();
    return caches.open('s4k-push').then(function (cache) {
      return cache.match('/__s4k_push_debug');
    }).then(function (res) {
      return res ? res.json() : null;
    }).then(function (info) {
      info = info || {};
      var p = info.pushCount || 0;
      App.util.dbg('push: SW push wakes so far — ' + p);
      if (p) App.util.dbg('push: last push wake ' + new Date(info.lastpush).toLocaleString());
    })['catch'](function () {});
  }

  /* Ask the gateway for its VAPID public key. Empty string means "push without
     VAPID" (the gateway wasn't configured with keys). */
  function fetchVapidKey() {
    return App.http.get('/v1/push/vapid').then(function (res) {
      return (res && res.publicKey) || '';
    })['catch'](function () { return ''; });
  }

  function registerWithGateway(sub) {
    return App.http.post('/v1/push/register', {
      number: App.config.number(),
      platform: 'kaios',
      subscription: sub.toJSON ? sub.toJSON() : sub
    });
  }

  /* KaiOS 3.0+ only: subscribe the ServiceWorker to the system messages we act on
     while backgrounded/closed, so the OS wakes it for them. NOTE: 'push' is NOT a
     systemMessage — it's owned by the Push API (pushManager.subscribe), and
     subscribing it here throws a SecurityError ("operation is insecure"). We only
     subscribe the genuine system messages ('notification' for click-wake, 'alarm'
     for reconnect). Feature-detected: systemMessageManager doesn't exist on 2.5,
     which wires wake-up through the manifest alone, so this is a clean no-op there.
     Idempotent, so it's safe to run on every boot. */
  function subscribeSystemMessages(reg) {
    if (!reg || !reg.systemMessageManager) return Promise.resolve();
    var names = ['notification', 'alarm'];
    return Promise.all(names.map(function (n) {
      try {
        return reg.systemMessageManager.subscribe(n)['catch'](function (e) {
          App.util.dbg('push: subscribe(' + n + ') failed — ' + (e && e.message));
        });
      } catch (e) {
        return Promise.resolve();
      }
    })).then(function () {
      App.util.dbg('push: system messages subscribed');
    });
  }

  /* Boot entry point: subscribe and register, automatically. Best-effort and
     non-blocking — any failure (unsupported platform, permission denied, gateway
     unreachable) is logged and swallowed so it never breaks startup. */
  function sync() {
    if (!supported()) {
      return Promise.resolve();
    }
    if (!App.config.isConfigured()) {
      return Promise.resolve();
    }
    return ensurePermission().then(function (perm) {
      App.util.dbg('push: notification permission = ' + perm);
      if (perm === 'denied') {
        App.util.dbg('push: notifications are blocked — enable them in ' +
          'Settings > Privacy & Security > App Permissions');
      }
      return fetchVapidKey();
    }).then(function (vapidKey) {
      return readCachedVapidKey().then(function (prevKey) {
        var keyChanged = (prevKey || '') !== (vapidKey || '');
        return navigator.serviceWorker.ready.then(function (reg) {
          return subscribeSystemMessages(reg).then(function () {
            return subscribe(reg, vapidKey, keyChanged);
          });
        }).then(function (sub) {
          return savePushCfg(vapidKey).then(function () {
            return registerWithGateway(sub);
          }).then(function () {
            App.util.dbg('push: subscribed (' + endpointHost(sub.endpoint) +
              ', …' + String(sub.endpoint || '').slice(-12) +
              (vapidKey ? ', VAPID' : ', keyless') + ')');
          });
        });
      });
    }).then(function () {
      return reportPushDebug();
    })['catch'](function (e) {
      App.util.dbg('push: subscribe failed — ' + (e && e.message));
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
    sync: sync
  };
})();
