(function () {
  'use strict';

  /* Direct Signal WebSocket manager (`wss://chat.signal.org/v1/websocket/`).
     Connects directly to Signal servers using the linked device's credentials (`login=<aci>.<deviceId>&password=<password>`),
     receives binary `WebSocketMessage` protobuf frames, decrypts `PUT /api/v1/message` envelopes on-device via `App.signal`,
     and sends a 200 OK `WebSocketResponseMessage` ACK only after the message is decrypted and ingested into IndexedDB.

     While our device is offline, Signal servers queue incoming envelopes and replay them when we connect,
     sending `PUT /api/v1/queue/empty` once the initial offline queue has drained. */

  var CLOSE_UNAUTHORIZED = 4001;
  var CLOSE_FORBIDDEN = 4003;

  var sock = null;
  var attempts = 0;
  var reconnectTimer = null;
  var keepaliveTimer = null;
  var wanted = false;
  var everConnected = false;
  var lastCloseAt = 0;
  var framesThisSession = 0;
  var drainingQueue = true; // true until `/api/v1/queue/empty` arrives on a new connection

  var SOCK_CONNECTING = 0;
  var SOCK_OPEN = 1;

  var HEARTBEAT_MS = 30000;
  var KEEPALIVE_MS = 25000;
  var WAKE_ALARM_MS = 300000;
  var heartbeatTimer = null;

  function state() {
    if (sock && sock.readyState === SOCK_OPEN) return 'open';
    if (sock && sock.readyState === SOCK_CONNECTING) return 'connecting';
    return 'closed';
  }

  function sendKeepalive() {
    if (!sock || sock.readyState !== SOCK_OPEN || !App.signal) return;
    try {
      sock.send(App.signal.encodeWsKeepalive());
    } catch (e) {
      App.util.dbg('ws: keepalive send failed ' + e.message);
    }
  }

  function sendAck(reqId, status, message) {
    if (!sock || sock.readyState !== SOCK_OPEN || reqId === undefined || !App.signal) return;
    try {
      sock.send(App.signal.encodeWsAck(reqId, status || 200, message || 'OK'));
    } catch (e) {
      App.util.dbg('ws: ack failed ' + e.message);
    }
  }

  function connect() {
    wanted = true;
    startHeartbeat();
    if (!App.config.isConfigured()) return;
    if (sock && (sock.readyState === SOCK_OPEN || sock.readyState === SOCK_CONNECTING)) {
      return;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    var loginId = (App.config.aci() || App.config.number()) + '.' + App.config.deviceId();
    // SECURITY-REVIEW: credentials passed to Signal WSS endpoint; redacted from debug logs.
    var url = App.config.wsUrl() + '/v1/websocket/?agent=OWD' +
      '&login=' + encodeURIComponent(loginId) +
      '&password=' + encodeURIComponent(App.config.deviceToken());

    App.util.dbg('ws: connecting ' + App.config.wsUrl() + '/v1/websocket/?agent=OWD&login=' + loginId);
    App.store.setConnection('connecting');
    drainingQueue = true;

    try {
      if (App.signal && App.signal.net) {
        sock = App.signal.net.openWebSocket(url);
      } else {
        sock = new WebSocket(url);
        sock.binaryType = 'arraybuffer';
      }
    } catch (e) {
      App.util.dbg('ws: constructor failed ' + e.message);
      scheduleReconnect();
      return;
    }

    sock.onopen = function () {
      attempts = 0;
      framesThisSession = 0;
      if (everConnected && lastCloseAt) {
        App.util.dbg('ws: reconnected after ' + (Date.now() - lastCloseAt) + 'ms gap');
        resync();
      } else {
        App.util.dbg('ws: open');
      }
      everConnected = true;
      scheduleWakeAlarm();
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      keepaliveTimer = setInterval(sendKeepalive, KEEPALIVE_MS);
      App.store.setConnection('open');
    };

    sock.onmessage = function (evt) {
      if (!App.signal) return;

      if (typeof evt.data === 'string') {
        App.util.dbg('ws: ignoring text frame');
        return;
      }

      var wsMsg;
      try {
        wsMsg = App.signal.decodeWsFrame(evt.data);
      } catch (e) {
        App.util.dbg('ws: failed to decode protobuf frame ' + e.message);
        return;
      }

      // WebSocketRequestMessage from Signal server (type === 1)
      if (wsMsg && wsMsg.type === 1 && wsMsg.request) {
        var req = wsMsg.request;
        if (req.path === '/api/v1/queue/empty') {
          drainingQueue = false;
          sendAck(req.id, 200, 'OK');
          App.util.dbg('ws: offline queue drain complete');
          return;
        }
        if (req.path === '/api/v1/message' && req.body && req.body.length) {
          var isSilent = drainingQueue;
          framesThisSession += 1;
          App.signal.processIncomingEnvelope(req.body).then(function (frame) {
            if (frame) {
              App.store.ingestRaw(frame, { silent: isSilent });
            }
            sendAck(req.id, 200, 'OK');
          })['catch'](function (err) {
            App.util.dbg('ws: envelope decrypt error: ' + (err && err.message));
            // ACK malformed/unrecoverable frame so it does not block the queue forever
            sendAck(req.id, 200, 'OK');
          });
          return;
        }
        sendAck(req.id, 200, 'OK');
      }
    };

    sock.onclose = function (evt) {
      lastCloseAt = Date.now();
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      App.util.dbg('ws: closed (code ' + evt.code + ', ' +
        framesThisSession + ' frames this session)');
      App.store.setConnection('closed');
      sock = null;

      if (evt.code === CLOSE_UNAUTHORIZED || evt.code === CLOSE_FORBIDDEN) {
        App.util.dbg('ws: Signal server rejected credentials (unlinked)');
        wanted = false;
        if (App.http.onUnlinked) App.http.onUnlinked();
        return;
      }

      if (wanted) scheduleReconnect();
    };

    sock.onerror = function () {
      App.util.dbg('ws: error');
    };
  }

  function resync() {
    if (App.store && App.store.refreshDirectory) {
      App.store.refreshDirectory()['catch'](function (e) {
        App.util.dbg('ws: resync directory failed ' + e.message);
      });
    }
  }

  function scheduleWakeAlarm() {
    var when = new Date(Date.now() + WAKE_ALARM_MS);
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
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
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
    if (App.signal && App.signal.net) App.signal.net.reset();
    attempts = 0;
    connect();
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && wanted && state() === 'closed') {
      attempts = 0;
      connect();
    }
  });

  function onWake() {
    App.util.dbg('ws: wake alarm fired');
    if (wanted && state() === 'closed') {
      attempts = 0;
      connect();
    }
    scheduleWakeAlarm();
  }

  // KaiOS 3.0 / 3.1 / 4.0: the 'alarm' system message goes to the ServiceWorker (sw.js), which relays it to open clients via postMessage.
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
