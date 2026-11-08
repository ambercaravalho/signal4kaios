'use strict';

/* ServiceWorker for signal4kaios v2.0.0 (KaiOS 3.0 / 3.1 / 4.0).
   Handles:
     1. 'systemmessage' (alarm) — relays periodic wake alarms to any open client so `ws.js`
        reconnects to Signal servers and drains queued messages.
     2. 'notificationclick' — focuses/opens the app on the tapped conversation.
*/

var PUSH_CACHE = 's4k-push';
var PENDING_CONV_KEY = '/__s4k_pending_conv';

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

self.addEventListener('systemmessage', function (event) {
  var name = event.name || (event.data && event.data.name);
  if (name && name !== 'alarm') return;
  var payload = event.data || {};
  var data = payload.data || payload;
  if (data && data.type && data.type !== 's4k-wake') return;
  event.waitUntil(relay({ type: 's4k-wake' })['catch'](function () {}));
});

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
        return savePendingConv(convId).then(function () {
          if (self.clients.openWindow) {
            return self.clients.openWindow('/index.html');
          }
          return null;
        });
      })
  );
});
