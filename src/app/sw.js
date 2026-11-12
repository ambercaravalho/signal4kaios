'use strict';

/* Beacon's ServiceWorker (KaiOS 3.0 / 3.1 / 4.0). It lets the app compile libsignal's WebAssembly on KaiOS 4.0, relays the app's wake alarm to an open window so the app reconnects, and opens the right chat when a notification is tapped. A closed app can't read messages: Signal only accepts the app's own authenticated connection. */

var WAKE_CACHE = 's4k-wake';
var LEGACY_CREDENTIALS_KEY = '/__s4k_wake_cfg';
var PENDING_CONV_KEY = '/__s4k_pending_conv';

self.addEventListener('install', function () {
  self.skipWaiting();
});

/* SECURITY-REVIEW: 2.0.x cached the device login here for a closed-app check; delete it on upgrade. */
function dropLegacyCredentials() {
  if (!self.caches) return Promise.resolve();
  return self.caches.open(WAKE_CACHE).then(function (cache) {
    return cache['delete'](LEGACY_CREDENTIALS_KEY);
  })['catch'](function () {});
}

self.addEventListener('activate', function (event) {
  event.waitUntil(Promise.all([self.clients.claim(), dropLegacyCredentials()]));
});

var SCRIPT_SRC = /^\s*script-src(\s|$)/i;
var ALLOWS_WASM = /\s'(wasm-)?unsafe-eval'(\s|$)/i;

/* SECURITY-REVIEW: KaiOS 4.0's api-daemon serves app pages with a policy whose script-src lacks 'wasm-unsafe-eval', so libsignal can't compile. This adds only that keyword to each script-src; every other directive, JavaScript eval, and inline scripts stay as strict as before. */
function allowWasm(header) {
  var changed = false;
  var policies = header.split(',').map(function (policy) {
    var directives = policy.split(';');
    var found = false;
    for (var i = 0; i < directives.length; i++) {
      if (!SCRIPT_SRC.test(directives[i])) continue;
      found = true;
      if (ALLOWS_WASM.test(directives[i])) continue;
      directives[i] = directives[i].replace(/\s*$/, '') + " 'wasm-unsafe-eval'";
      changed = true;
    }
    return found ? directives.join(';') : null;
  });
  if (!changed || policies.indexOf(null) !== -1) return null;
  return policies.join(',');
}

function withWasmAllowed(response) {
  try {
    var policy = response.ok && response.headers.get('Content-Security-Policy');
    var allowed = policy ? allowWasm(policy) : null;
    if (!allowed) return response;
    var headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', allowed);
    // The body is read already decoded, so the original encoding and length no longer describe it.
    headers['delete']('Content-Encoding');
    headers['delete']('Content-Length');
    return response.clone().blob().then(function (body) {
      return new Response(body, { status: response.status, statusText: response.statusText, headers: headers });
    }, function () {
      return response;
    });
  } catch (e) {
    return response;
  }
}

self.addEventListener('fetch', function (event) {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).then(withWasmAllowed));
});

function relayWake() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
    (clientList || []).forEach(function (client) {
      try { client.postMessage({ type: 's4k-wake' }); } catch (e) { /* client gone */ }
    });
  })['catch'](function () {});
}

self.addEventListener('systemmessage', function (event) {
  var name = event.name || (event.data && event.data.name);
  if (name && name !== 'alarm') return;
  var payload = event.data || {};
  var data = payload.data || payload;
  if (data && data.type && data.type !== 's4k-wake') return;
  event.waitUntil(relayWake());
});

/* A closed app can't receive postMessage, so the chat to open waits in Cache Storage for the next launch. */
function savePendingConv(convId) {
  if (!convId || !self.caches) return Promise.resolve();
  return self.caches.open(WAKE_CACHE).then(function (cache) {
    return cache.put(PENDING_CONV_KEY, new Response(
      JSON.stringify({ convId: convId, ts: Date.now() }),
      { headers: { 'Content-Type': 'application/json' } }
    ));
  })['catch'](function () {});
}

self.addEventListener('notificationclick', function (event) {
  var n = event.notification;
  var convId = (n && n.data && typeof n.data.convId === 'string' && n.data.convId) || null;
  n.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      var msg = { type: 's4k-open-conversation', convId: convId };
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) {
          try { client.postMessage(msg); } catch (e) { /* client gone */ }
          return client.focus();
        }
      }
      return savePendingConv(convId).then(function () {
        return self.clients.openWindow ? self.clients.openWindow('/index.html') : null;
      });
    })
  );
});
