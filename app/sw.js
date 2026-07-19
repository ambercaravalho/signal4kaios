'use strict';

/* ServiceWorker for KaiOS 3.0+ (3.0/3.1/4.0; no-op on 2.5, which has none).

   It exists for things the page can't do on its own once backgrounded/closed:
     1. Receive the KaiOS 'alarm' system message and relay a wake signal to the
        page so ws.js can reconnect and drain queued messages. This is the
        3.0/4.0 equivalent of mozSetMessageHandler('alarm') on 2.5.
     2. Handle 'push' messages from the gateway (see docs/gateway.md) and show a
        notification even when the app is fully closed — the only way to notify
        without a running WebSocket. If a push carries no readable payload it
        falls back to asking the gateway what's pending.
     3. Handle notification clicks so tapping a message notification focuses the
        app and opens the right conversation.

   Kept deliberately small and dependency-free; it shares nothing with the
   page's App.* modules. Gateway coordinates (base URL, number, VAPID key, and —
   in token auth mode — the receive token/param) are handed over by push.js via
   Cache Storage so this worker can act with the app closed. */

var NOTIF_ICON = '/assets/icons/kaios_112.png';
var PUSH_CACHE = 's4k-push';
var PUSH_CFG_KEY = '/__s4k_push_cfg';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
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

/* KaiOS delivers system messages (e.g. 'alarm') to the ServiceWorker via a
   'systemmessage' event. Relay wake alarms to any open window so the receive
   socket can reconnect. */
self.addEventListener('systemmessage', function (event) {
  var name = event.name || (event.data && event.data.name);
  if (name && name !== 'alarm') return;
  var payload = event.data || {};
  var data = payload.data || payload;
  if (data && data.type && data.type !== 's4k-wake') return;
  event.waitUntil(relay({ type: 's4k-wake' }));
});

/* Convert a base64url VAPID key into the Uint8Array applicationServerKey wants.
   Mirrors the helper in push.js so the worker can re-subscribe on its own. */
function urlB64ToUint8Array(base64) {
  var padding = '='.repeat((4 - (base64.length % 4)) % 4);
  var b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  var raw = self.atob(b64);
  var arr = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/* Gateway coordinates written by push.js (page side) so this worker can reach
   the gateway while the app is closed. Returns null if push isn't set up. */
function readPushCfg() {
  if (!self.caches) return Promise.resolve(null);
  return self.caches.open(PUSH_CACHE).then(function (cache) {
    return cache.match(PUSH_CFG_KEY);
  }).then(function (res) {
    return res ? res.json() : null;
  })['catch'](function () { return null; });
}

/* Append the receive token as a query param (token auth mode) so the worker's
   own cross-origin fetches pass a reverse proxy in front of the gateway. */
function withToken(url, cfg) {
  if (!cfg || !cfg.token || !cfg.tokenParam) return url;
  var sep = url.indexOf('?') === -1 ? '?' : '&';
  return url + sep + encodeURIComponent(cfg.tokenParam) + '=' +
    encodeURIComponent(cfg.token);
}

function showFromPayload(p) {
  var title = (p && p.title) || 'Signal';
  return self.registration.showNotification(title, {
    body: (p && p.body) || 'New message',
    tag: (p && p.convId) || 'signal',
    icon: NOTIF_ICON,
    data: { convId: (p && p.convId) || null }
  });
}

/* Fallback for "tickle" pushes with no readable payload: ask the gateway what's
   pending for this number. The gateway sends CORS headers on /v1/push/* so this
   cross-origin fetch can read the response. */
function fetchPending() {
  return readPushCfg().then(function (cfg) {
    if (!cfg || !cfg.serverUrl) return null;
    var base = cfg.serverUrl.replace(/\/+$/, '');
    var url = withToken(base + '/v1/push/pending?number=' +
      encodeURIComponent(cfg.number || ''), cfg);
    return self.fetch(url, { mode: 'cors' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return null;
        return data.messages || data.items || (data.length ? data : null);
      });
  })['catch'](function () { return null; });
}

/* Web Push. userVisibleOnly means we MUST show a notification for every push,
   so every branch ends in showNotification (even on error). */
self.addEventListener('push', function (event) {
  var payload = null;
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (e) {
      try { payload = { body: event.data.text() }; } catch (e2) { payload = null; }
    }
  }

  if (payload && (payload.title || payload.body || payload.convId)) {
    event.waitUntil(showFromPayload(payload));
    return;
  }

  event.waitUntil(
    fetchPending().then(function (items) {
      if (items && items.length) {
        return Promise.all(items.map(showFromPayload));
      }
      return showFromPayload({ title: 'Signal', body: 'New message' });
    })['catch'](function () {
      return showFromPayload({ title: 'Signal', body: 'New message' });
    })
  );
});

/* The push service can rotate a subscription; re-subscribe and tell the gateway
   the new endpoint (fire-and-forget — we don't need the response). */
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(
    readPushCfg().then(function (cfg) {
      if (!cfg || !cfg.serverUrl) return null;
      function reRegister(sub) {
        var body = {
          number: cfg.number || '',
          subscription: (sub && sub.toJSON) ? sub.toJSON() : sub
        };
        var url = withToken(cfg.serverUrl.replace(/\/+$/, '') + '/v1/push/register', cfg);
        return self.fetch(url, {
          method: 'POST', mode: 'cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })['catch'](function () { return null; });
      }
      if (event.newSubscription) return reRegister(event.newSubscription);
      var opts = { userVisibleOnly: true };
      if (cfg.vapidKey) opts.applicationServerKey = urlB64ToUint8Array(cfg.vapidKey);
      return self.registration.pushManager.subscribe(opts).then(reRegister);
    })['catch'](function () { return null; })
  );
});

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
        if (self.clients.openWindow) {
          return self.clients.openWindow('/index.html');
        }
        return null;
      })
  );
});
