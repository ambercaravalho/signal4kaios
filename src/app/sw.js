'use strict';

/* Beacon's ServiceWorker (KaiOS 3.0 / 3.1 / 4.0). It lets the app compile libsignal's WebAssembly on KaiOS 4.0, supervises the app through its wake alarm (relaying it to an open window, or reopening Beacon when it was closed), brings Beacon forward for an incoming call, and opens the right chat when a notification is tapped. The worker can't read messages itself: Signal only accepts the app's own authenticated connection. */

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

var WAKE_ALARM = 's4k-wake';
var FOCUS_ALARM = 's4k-focus';
var STOPPED_TAG = 's4k-stopped';
var WAKE_ALARM_MS = 300000;

function windowClients() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    return list || [];
  }, function () {
    return [];
  });
}

function relayWake(clientList) {
  clientList.forEach(function (client) {
    try { client.postMessage({ type: WAKE_ALARM }); } catch (e) { /* client gone */ }
  });
}

function scheduleWake(ms, notice) {
  var b2g = self.navigator && self.navigator.b2g;
  var am = b2g && b2g.alarmManager;
  if (!am || !am.add) return Promise.resolve();
  try {
    return Promise.resolve(am.add({ date: new Date(Date.now() + ms), data: { type: WAKE_ALARM, notice: notice }, ignoreTimezone: false }))['catch'](function () {});
  } catch (e) {
    return Promise.resolve();
  }
}

/* KaiOS 3.x opens a window hidden for a core app with background-window. KaiOS 4.0's ClientDisposition has no 'background' value, so the call throws there, and its system app only honours hidden windows on MVS devices. */
function relaunchHidden() {
  try {
    return self.clients.openWindow('/index.html#bg', { disposition: 'background' }).then(function (client) {
      return !!client;
    }, function () {
      return false;
    });
  } catch (e) {
    return Promise.resolve(false);
  }
}

function showStoppedNotice(notice) {
  var reg = self.registration;
  if (!reg || !reg.showNotification || !notice || typeof notice.title !== 'string') return Promise.resolve();
  return reg.getNotifications({ tag: STOPPED_TAG }).then(function (open) {
    if (open && open.length) return;
    return reg.showNotification(notice.title, { body: String(notice.body || ''), tag: STOPPED_TAG, icon: '/assets/icons/kaios_112.png', data: { reopen: true } });
  })['catch'](function () {});
}

/* The wake alarm supervises the app: an open window reconnects and schedules the next alarm itself; with no window, Beacon is relaunched hidden where KaiOS allows it, and otherwise one notification offers to reopen it. */
function onWakeAlarm(data) {
  return windowClients().then(function (clientList) {
    if (clientList.length) return relayWake(clientList);
    return relaunchHidden().then(function (opened) {
      if (opened) return scheduleWake(WAKE_ALARM_MS, data.notice);
      return showStoppedNotice(data.notice);
    });
  });
}

/* Clients.focus() is only allowed while handling a system message or a notification click, so the app asks for it through an alarm due now. */
function onFocusAlarm() {
  return windowClients().then(function (clientList) {
    if (!clientList.length || !clientList[0].focus) return;
    return clientList[0].focus()['catch'](function () {});
  });
}

var TICK = 's4k-tick';
var TICK_MIN_MS = 1000;
var TICK_MAX_MS = 60000;

/* Gecko suspends a background page's timers (dom.suspend_inactive.enabled) but still delivers its events, and a ServiceWorker's timers keep running, so the hidden app asks for a tick and the worker answers when it's due. Each request is a new event, which keeps the worker alive while the app keeps asking. */
self.addEventListener('message', function (event) {
  var d = event.data;
  if (!d || d.type !== TICK) return;
  var ms = Math.min(Math.max(Number(d.ms) || 0, TICK_MIN_MS), TICK_MAX_MS);
  var source = event.source;
  event.waitUntil(new Promise(function (resolve) {
    setTimeout(function () {
      try { if (source) source.postMessage({ type: TICK, id: d.id }); } catch (e) { /* client gone */ }
      resolve();
    }, ms);
  }));
});

function alarmData(event) {
  var d = event.data;
  var payload = null;
  try { payload = d && typeof d.json === 'function' ? d.json() : d; } catch (e) { payload = null; }
  var data = payload && typeof payload.data === 'object' ? payload.data : payload;
  return data && typeof data === 'object' && typeof data.type === 'string' ? data : null;
}

self.addEventListener('systemmessage', function (event) {
  var name = event.name || (event.data && event.data.name);
  if (name && name !== 'alarm') return;
  var data = alarmData(event);
  if (!data) return;
  if (data.type === WAKE_ALARM) event.waitUntil(onWakeAlarm(data));
  else if (data.type === FOCUS_ALARM) event.waitUntil(onFocusAlarm());
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
