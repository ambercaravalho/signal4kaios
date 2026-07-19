'use strict';

/* ServiceWorker for KaiOS 3.0+ (3.0/3.1/4.0; no-op on 2.5, which has none).

   It exists for two things the page can't do on its own once backgrounded:
     1. Receive the KaiOS 'alarm' system message and relay a wake signal to the
        page so ws.js can reconnect and drain queued messages. This is the
        3.0/4.0 equivalent of mozSetMessageHandler('alarm') on 2.5.
     2. Handle notification clicks so tapping a message notification focuses the
        app and opens the right conversation.

   Kept deliberately small and dependency-free; it shares nothing with the
   page's App.* modules. */

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

self.addEventListener('notificationclick', function (event) {
  var convId = event.notification && event.notification.tag;
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
