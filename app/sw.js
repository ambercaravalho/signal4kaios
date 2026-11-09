'use strict';

/* ServiceWorker for signal4kaios v2.0.0 (KaiOS 3.0 / 3.1 / 4.0).
   Handles:
     1. 'systemmessage' (alarm) —
        - If a window client is open, relays `{ type: 's4k-wake' }` so `ws.js` reconnects and drains messages.
        - If the app is completely closed (no window clients), re-schedules the next KaiOS wake alarm,
          connects briefly to Signal's WebSocket (`wss://chat.signal.org/v1/websocket/`) without ACKing envelopes
          to check if any `/api/v1/message` frames are waiting in the offline queue, and if so raises a
          system notification ("New Signal message") so tapping it launches the app and decrypts the queue.
     2. 'notificationclick' — focuses/opens the app on the tapped conversation.
*/

var NOTIF_ICON = '/assets/icons/kaios_112.png';
var PUSH_CACHE = 's4k-push';
var WAKE_CFG_KEY = '/__s4k_wake_cfg';
var PENDING_CONV_KEY = '/__s4k_pending_conv';
var WAKE_ALARM_MS = 300000; // 5 minutes

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

function scheduleNextAlarm() {
  try {
    var b2g = self.navigator && self.navigator.b2g;
    if (b2g && b2g.alarmManager && b2g.alarmManager.add) {
      return b2g.alarmManager.add({
        date: new Date(Date.now() + WAKE_ALARM_MS),
        data: { type: 's4k-wake' },
        ignoreTimezone: false
      })['catch'](function () {});
    }
  } catch (e) { /* unavailable in worker context */ }
  return Promise.resolve();
}

function readWakeCfg() {
  if (!self.caches) return Promise.resolve(null);
  return self.caches.open(PUSH_CACHE).then(function (cache) {
    return cache.match(WAKE_CFG_KEY);
  }).then(function (res) {
    return res ? res.json() : null;
  })['catch'](function () { return null; });
}

/* Probe Signal's WebSocket while the app is closed to see if any queued `/api/v1/message` envelopes
   arrive before `/api/v1/queue/empty`. Does NOT send 200 OK ACKs so the envelopes stay safely on the server
   until the user opens the app (or the page decrypts them). */
function probeOfflineQueue(cfg) {
  return new Promise(function (resolve) {
    if (!cfg || !cfg.wsUrl || !cfg.login || !cfg.password || typeof WebSocket === 'undefined') {
      resolve(0);
      return;
    }
    var count = 0;
    var done = false;
    var sock = null;
    var timer = setTimeout(function () {
      finish();
    }, 6000);

    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (sock) {
        try { sock.close(); } catch (e) {}
        sock = null;
      }
      resolve(count);
    }

    try {
      var url = cfg.wsUrl.replace(/\/+$/, '') + '/v1/websocket/?agent=OWD' +
        '&login=' + encodeURIComponent(cfg.login) +
        '&password=' + encodeURIComponent(cfg.password);
      sock = new WebSocket(url);
      sock.binaryType = 'arraybuffer';
      sock.onmessage = function (evt) {
        try {
          var bytes = new Uint8Array(evt.data);
          var text = new TextDecoder().decode(bytes);
          if (text.indexOf('/api/v1/message') >= 0) {
            count += 1;
            finish();
          } else if (text.indexOf('/api/v1/queue/empty') >= 0) {
            finish();
          }
        } catch (e) {
          finish();
        }
      };
      sock.onerror = finish;
      sock.onclose = finish;
    } catch (e) {
      finish();
    }
  });
}

function handleWakeAlarm() {
  return scheduleNextAlarm().then(function () {
    return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  }).then(function (clientList) {
    if (clientList && clientList.length > 0) {
      clientList.forEach(function (client) {
        try { client.postMessage({ type: 's4k-wake' }); } catch (e) {}
      });
      return null;
    }
    // App is completely closed: check if Signal has queued messages for us
    return readWakeCfg().then(function (cfg) {
      return probeOfflineQueue(cfg);
    }).then(function (pendingCount) {
      if (pendingCount > 0 && self.registration && self.registration.showNotification) {
        return self.registration.showNotification('Signal', {
          body: 'New encrypted message waiting — open Signal to read',
          tag: 'signal',
          icon: NOTIF_ICON,
          data: { convId: null }
        });
      }
      return null;
    });
  })['catch'](function () {});
}

self.addEventListener('systemmessage', function (event) {
  var name = event.name || (event.data && event.data.name);
  if (name && name !== 'alarm') return;
  var payload = event.data || {};
  var data = payload.data || payload;
  if (data && data.type && data.type !== 's4k-wake') return;
  event.waitUntil(handleWakeAlarm());
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
