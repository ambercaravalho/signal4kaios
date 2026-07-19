(function () {
  'use strict';

  /* WebSocket manager for ws://<server>/v1/receive/<number> (json-rpc mode).
     Reconnects with exponential backoff + jitter; also reconnects when the
     app returns to the foreground.

     Basic-auth limitation: browsers refuse both custom WebSocket handshake
     headers and userinfo (user:pass@) in ws:// URLs, so this code can never
     attach an Authorization header to the handshake. An earlier version tried
     priming Gecko's HTTP auth cache with a prior XHR, on the theory that the
     cache would carry over to the handshake — confirmed against a Traefik-based
     proxy (Pangolin's "header auth") that it does not. Basic Auth middlewares
     are stateless and check every request independently, including the WS
     upgrade, and no browser API lets a WebSocket client satisfy that.

     The one thing the WebSocket URL *can* carry is a query string, so the
     supported way to authenticate the receive path is a query token that the
     proxy validates itself. For Pangolin this is a Resource Access Token,
     passed as ?p_token=<id>.<secret> (Pangolin's default query param is
     p_token). Set it as App.config.receiveToken. Note that Pangolin path
     rules match the URL path with the query stripped, so a rule can never
     match on the token — the access-token feature is what reads the query.
     Alternatively exempt the path and protect it at the network level (IP
     allowlist / tunnel). See docs/remote-access.md. */

  var sock = null;
  var attempts = 0;
  var reconnectTimer = null;
  var wanted = false;
  var opened = false;
  var warnedAuth = false;
  var everConnected = false; // have we had at least one successful open?
  var lastCloseAt = 0;       // when the socket last dropped (for gap logging)
  var framesThisSession = 0; // frames received since the current open

  var HEARTBEAT_MS = 30000;  // safety-net poll for a silently-dead socket
  var WAKE_ALARM_MS = 300000; // how far ahead to schedule the wake alarm
  var heartbeatTimer = null;

  function state() {
    if (sock && sock.readyState === WebSocket.OPEN) return 'open';
    if (sock && sock.readyState === WebSocket.CONNECTING) return 'connecting';
    return 'closed';
  }

  function connect() {
    wanted = true;
    startHeartbeat();
    if (!App.config.isConfigured()) return;
    if (sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    var url = App.config.wsUrl() + '/v1/receive/' +
      encodeURIComponent(App.config.number());
    // Optional proxy-auth token for the receive path (a browser WebSocket can't
    // send Basic Auth). Sent as ?p_token=<id>.<secret>, which Pangolin reads as
    // a Resource Access Token. Redact it from the debug log — it's a secret.
    var tok = App.config.receiveToken();
    if (tok) url += '?p_token=' + encodeURIComponent(tok);
    App.util.dbg('ws: connecting ' + url.replace(/([?&]p_token=)[^&]*/, '$1***'));
    App.store.setConnection('connecting');

    var startedAt = Date.now();
    opened = false;

    try {
      sock = new WebSocket(url);
    } catch (e) {
      App.util.dbg('ws: constructor failed ' + e.message);
      scheduleReconnect();
      return;
    }

    sock.onopen = function () {
      opened = true;
      attempts = 0;
      warnedAuth = false;
      framesThisSession = 0;
      // Diagnostics for the "missed while disconnected" investigation: note
      // whether this is a reconnect and how long the gap was, so the debug
      // log shows whether signal-cli drains its queue on the fresh socket.
      if (everConnected && lastCloseAt) {
        App.util.dbg('ws: reconnected after ' + (Date.now() - lastCloseAt) +
          'ms gap — any messages queued while offline should stream now');
        // Best-effort catch-up: signal-cli should stream queued messages on the
        // fresh socket; refresh the directory so any new contacts/groups that
        // appeared while we were offline resolve correctly. There is no history
        // API, so already-delivered messages we missed cannot be backfilled.
        resync();
      } else {
        App.util.dbg('ws: open');
      }
      everConnected = true;
      scheduleWakeAlarm();
      App.store.setConnection('open');
    };

    sock.onmessage = function (evt) {
      var frame;
      try {
        frame = JSON.parse(evt.data);
      } catch (e) {
        App.util.dbg('ws: non-JSON frame', evt.data);
        return;
      }
      framesThisSession += 1;
      App.store.ingestRaw(frame);
    };

    sock.onclose = function (evt) {
      lastCloseAt = Date.now();
      App.util.dbg('ws: closed (code ' + evt.code + ', ' +
        framesThisSession + ' frames this session)');
      App.store.setConnection('closed');
      sock = null;

      // A handshake that's rejected (e.g. a 401 from Basic Auth, or a bad/missing
      // receive token) closes immediately without ever opening — that pattern,
      // with proxy auth configured, is the one thing the app can detect here.
      if (!opened && Date.now() - startedAt < 5000 &&
        (App.config.hasBasicAuth() || App.config.receiveToken())) {
        if (App.config.receiveToken()) {
          App.util.dbg('ws: closed before opening with a receive token set — ' +
            'the proxy likely rejected it (wrong/expired token, or it is not a ' +
            'valid <id>.<secret> access token — see docs/remote-access.md)');
        } else {
          App.util.dbg('ws: closed before opening with Basic Auth configured — ' +
            'the proxy is likely rejecting the handshake (see README: ' +
            'Basic Auth cannot authenticate a WebSocket in any browser)');
        }
        if (!warnedAuth) {
          warnedAuth = true;
          App.toast('Live updates blocked by the proxy auth — see Debug log');
        }
      }

      if (wanted) scheduleReconnect();
    };

    sock.onerror = function () {
      App.util.dbg('ws: error');
      // onclose follows and handles the reconnect.
    };
  }

  function resync() {
    if (App.store && App.store.refreshDirectory) {
      App.store.refreshDirectory()['catch'](function (e) {
        App.util.dbg('ws: resync directory failed ' + e.message);
      });
    }
  }

  /* KaiOS can suspend a backgrounded app; a mozAlarm wakes it up so the socket
     can be re-established and queued messages can drain. Feature-detected: on
     desktop / the simulator without mozAlarms this is a no-op. Full delivery
     while the app is fully killed also needs a system-message handler, which is
     a separate (and largely unsupported) concern — this only helps while the
     app is still resident but suspended. */
  function scheduleWakeAlarm() {
    var when = new Date(Date.now() + WAKE_ALARM_MS);
    // App.platform picks navigator.b2g.alarmManager (3.0/4.0) or
    // navigator.mozAlarms (2.5); rejects (harmless no-op) off-device.
    App.platform.scheduleAlarm(when, { type: 's4k-wake' })['catch'](function (e) {
      App.util.dbg('ws: could not schedule wake alarm ' + (e && e.message));
    });
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(function () {
      if (wanted && state() === 'closed' && !reconnectTimer) {
        App.util.dbg('ws: heartbeat found a dead socket — reconnecting');
        attempts = 0;
        connect();
      }
    }, HEARTBEAT_MS);
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    attempts += 1;
    var base = Math.min(60000, 1000 * Math.pow(2, Math.min(attempts, 6)));
    var delay = base / 2 + Math.floor(Math.random() * (base / 2));
    App.util.dbg('ws: reconnect in ' + delay + 'ms (attempt ' + attempts + ')');
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function stop() {
    wanted = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (sock) {
      sock.onclose = null;
      try { sock.close(); } catch (e) { /* already closed */ }
      sock = null;
    }
    App.store.setConnection('closed');
  }

  function restart() {
    stop();
    attempts = 0;
    warnedAuth = false;
    connect();
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && wanted && state() === 'closed') {
      attempts = 0;
      connect();
    }
  });

  // When a wake alarm fires, reconnect (if we still want a connection) and
  // arm the next alarm.
  function onWake() {
    App.util.dbg('ws: wake alarm fired');
    if (wanted && state() === 'closed') {
      attempts = 0;
      connect();
    }
    scheduleWakeAlarm();
  }

  // KaiOS 2.5: the 'alarm' system message is delivered straight to the page via
  // mozSetMessageHandler. Feature-detected so it is harmless off-device.
  try {
    if (navigator.mozSetMessageHandler) {
      navigator.mozSetMessageHandler('alarm', function (msg) {
        var data = msg && msg.data;
        if (data && data.type !== 's4k-wake') return;
        onWake();
      });
    }
  } catch (e) {
    App.util.dbg('ws: alarm handler unavailable ' + e.message);
  }

  // KaiOS 3.0/4.0: the 'alarm' system message goes to the ServiceWorker (sw.js),
  // which relays it to open clients via postMessage. Listen for that relay.
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.addEventListener) {
      navigator.serviceWorker.addEventListener('message', function (evt) {
        var data = evt && evt.data;
        if (data && data.type === 's4k-wake') onWake();
      });
    }
  } catch (e2) {
    App.util.dbg('ws: sw message handler unavailable ' + e2.message);
  }

  App.ws = {
    connect: connect,
    stop: stop,
    restart: restart,
    state: state
  };
})();
