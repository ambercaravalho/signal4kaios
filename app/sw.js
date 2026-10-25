'use strict';

/* ServiceWorker for signal4kaios — runs on every KaiOS with the Push API (2.5 and 3.0/3.1/4.0). It does the things the page can't once the app is backgrounded or fully closed:

     1. 'push' — the gateway sends an aesgcm-encrypted push for each incoming message (see docs/development.md); this worker shows the notification even when the app is closed. This is the ONLY closed-app notification path.
     2. 'systemmessage' (alarm) — if a window is still open (backgrounded app), relay a wake so ws.js reconnects and drains queued messages. When the app is fully closed, push handles notifications, so the alarm does nothing here.
     3. 'notificationclick' — focus/open the app on the right conversation.
     4. 'activate' / 'pushsubscriptionchange' — re-subscribe on its own when the OS has dropped or rotated the push subscription.

   Kept small, dependency-free, and Gecko-48-safe (var/function only, no arrow functions, template literals, or let/const) since it also runs on KaiOS 2.5. It shares nothing with the page's App.* modules; the page hands over the gateway coordinates (base URL, number, VAPID key, and the paired device token) via Cache Storage so this worker can re-register a rotated push subscription on its own. */

var NOTIF_ICON = '/assets/icons/kaios_112.png';
var PUSH_CACHE = 's4k-push';
var PUSH_CFG_KEY = '/__s4k_push_cfg';
var PUSH_DEBUG_KEY = '/__s4k_push_debug';
var PENDING_CONV_KEY = '/__s4k_pending_conv';

self.addEventListener('install', function () {
  self.skipWaiting();
});

/* KaiOS 3.0+ deletes every app's push subscription whenever the phone boots after anything but a clean power-off/reboot (b2g crash, battery pull, forced restart), then re-registers this worker from the manifest — which fires 'activate' with the app closed. Re-subscribe here so closed-app notifications survive that without the user opening the app. */
self.addEventListener('activate', function (event) {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    ensureSubscribed()
  ]));
});

function relay(message) {
  return self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(function (clientList) {
      clientList.forEach(function (client) {
        try { client.postMessage(message); } catch (e) { /* client gone */ }
      });
      return clientList;
    });
}

/* Update the breadcrumb record the page reports in the in-app Debug log (there's no console on the phone). update(info) mutates it in place. Best-effort; never rejects. */
function noteDebug(update) {
  if (!self.caches) return Promise.resolve();
  return self.caches.open(PUSH_CACHE).then(function (cache) {
    return cache.match(PUSH_DEBUG_KEY).then(function (res) {
      return res ? res.json() : null;
    }).then(function (prev) {
      var info = prev || {};
      update(info);
      return cache.put(PUSH_DEBUG_KEY, new Response(JSON.stringify(info), {
        headers: { 'Content-Type': 'application/json' }
      }));
    });
  })['catch'](function () { /* diagnostics only */ });
}

function notePushWake() {
  return noteDebug(function (info) {
    info.pushCount = (info.pushCount || 0) + 1;
    info.lastpush = Date.now();
  });
}

/* field is 'pushError' (decoding the push) or 'showError' (showNotification rejected). */
function noteError(field, e) {
  var msg = e ? String((e.name ? e.name + ': ' : '') + (e.message || e)).slice(0, 160) : 'unknown';
  return noteDebug(function (info) {
    info[field] = { msg: msg, ts: Date.now() };
  });
}

/* KaiOS delivers the 'alarm' system message to the worker as a 'systemmessage' event. Its only remaining job is to nudge a still-open (backgrounded) window to reconnect; the page re-arms the next alarm itself. A fully-closed app is notified via push, not here. */
self.addEventListener('systemmessage', function (event) {
  var name = event.name || (event.data && event.data.name);
  if (name && name !== 'alarm') return;
  var payload = event.data || {};
  var data = payload.data || payload;
  if (data && data.type && data.type !== 's4k-wake') return;
  event.waitUntil(relay({ type: 's4k-wake' })['catch'](function () {}));
});

/* Convert a base64url VAPID key into the Uint8Array applicationServerKey wants. Mirrors the helper in push.js so the worker can re-subscribe on its own. */
function urlB64ToUint8Array(base64) {
  var padding = new Array((4 - (base64.length % 4)) % 4 + 1).join('=');
  var b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  var raw = self.atob(b64);
  var arr = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/* Gateway coordinates written by push.js (page side) so this worker can reach the gateway while the app is closed. Returns null if push isn't set up. */
function readPushCfg() {
  if (!self.caches) return Promise.resolve(null);
  return self.caches.open(PUSH_CACHE).then(function (cache) {
    return cache.match(PUSH_CFG_KEY);
  }).then(function (res) {
    return res ? res.json() : null;
  })['catch'](function () { return null; });
}

/* Headers for the worker's own gateway fetches: JSON plus the paired device token (the gateway rejects unauthenticated push routes). */
function gatewayHeaders(cfg) {
  var h = { 'Content-Type': 'application/json' };
  if (cfg && cfg.token) h.Authorization = 'Bearer ' + cfg.token;
  return h;
}

/* Re-register a subscription with the gateway (fire-and-forget — we don't need the response). */
function reRegister(cfg, sub) {
  var body = {
    number: cfg.number || '',
    subscription: (sub && sub.toJSON) ? sub.toJSON() : sub
  };
  var url = cfg.serverUrl.replace(/\/+$/, '') + '/v1/push/register';
  return self.fetch(url, {
    method: 'POST', mode: 'cors',
    headers: gatewayHeaders(cfg),
    body: JSON.stringify(body)
  })['catch'](function () { return null; });
}

function subscribeWithCfg(cfg) {
  var opts = { userVisibleOnly: true };
  if (cfg.vapidKey) opts.applicationServerKey = urlB64ToUint8Array(cfg.vapidKey);
  return self.registration.pushManager.subscribe(opts);
}

/* If the page has set push up before but this worker has no subscription (the boot-time wipe), make a new one and register it. A no-op on first install (no cfg yet) and whenever a subscription already exists. */
function ensureSubscribed() {
  return readPushCfg().then(function (cfg) {
    if (!cfg || !cfg.serverUrl || !self.registration.pushManager) return null;
    return self.registration.pushManager.getSubscription().then(function (existing) {
      if (existing) return null;
      return subscribeWithCfg(cfg).then(function (sub) {
        return noteDebug(function (info) {
          info.resubscribed = { tail: String(sub.endpoint || '').slice(-12), ts: Date.now() };
        }).then(function () { return reRegister(cfg, sub); });
      });
    });
  })['catch'](function (e) { return noteError('resubscribeError', e); });
}

function showFromPayload(p) {
  var title = (p && p.title) || 'Signal';
  return self.registration.showNotification(title, {
    body: (p && p.body) || 'New message',
    tag: (p && p.convId) || 'signal',
    icon: NOTIF_ICON,
    data: { convId: (p && p.convId) || null }
  })['catch'](function (e) { return noteError('showError', e); });
}

/* Web Push. userVisibleOnly means we MUST show a notification for every push, so every branch ends in showNotification. The gateway sends an aesgcm-encrypted JSON payload; a keyless (no-VAPID) gateway can only send empty pushes, which fall back to a generic notice. */
self.addEventListener('push', function (event) {
  event.waitUntil(notePushWake());
  var payload = null;
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (e) {
      event.waitUntil(noteError('pushError', e));
      try { payload = { body: event.data.text() }; } catch (e2) { payload = null; }
    }
  }
  event.waitUntil(showFromPayload(payload || { title: 'Signal', body: 'New message' }));
});

/* The push service can rotate a subscription; re-subscribe and tell the gateway the new endpoint. */
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(
    readPushCfg().then(function (cfg) {
      if (!cfg || !cfg.serverUrl) return null;
      if (event.newSubscription) return reRegister(cfg, event.newSubscription);
      return subscribeWithCfg(cfg).then(function (sub) { return reRegister(cfg, sub); });
    })['catch'](function () { return null; })
  );
});

/* Stash the tapped conversation so a cold-started app can route to it. The page reads and clears this on boot (fresh entries only). Best-effort. */
function savePendingConv(convId) {
  if (!convId || !self.caches) return Promise.resolve();
  return self.caches.open(PUSH_CACHE).then(function (cache) {
    return cache.put(PENDING_CONV_KEY, new Response(
      JSON.stringify({ convId: convId, ts: Date.now() }),
      { headers: { 'Content-Type': 'application/json' } }
    ));
  })['catch'](function () { /* best-effort */ });
}

self.addEventListener('notificationclick', function (event) {
  var n = event.notification;
  var convId = (n && n.data && n.data.convId) || (n && n.tag) || null;
  if (convId === 'signal') convId = null;
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (clientList) {
        var msg = { type: 's4k-open-conversation', convId: convId };
        for (var i = 0; i < clientList.length; i++) {
          var client = clientList[i];
          if ('focus' in client) {
            try { client.postMessage(msg); } catch (e) { /* client gone */ }
            return client.focus();
          }
        }
        // No live window: persist the target so main.js can open it once the cold-started app has booted, then launch the app.
        return savePendingConv(convId).then(function () {
          if (self.clients.openWindow) {
            return self.clients.openWindow('/index.html');
          }
          return null;
        });
      })
  );
});
