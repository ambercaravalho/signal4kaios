(function () {
  'use strict';

  /* WebSocket manager for ws://<server>/v1/receive/<number> (json-rpc mode).
     Reconnects with exponential backoff + jitter; also reconnects when the
     app returns to the foreground.

     Basic-auth caveat: browsers refuse both custom WebSocket handshake
     headers and userinfo (user:pass@) in ws:// URLs, so there is no way for
     this code to attach an Authorization header to the handshake directly.
     What does work: once an XHR to the same origin succeeds with HTTP
     Basic Auth, Gecko's own HTTP auth cache remembers the credentials for
     that origin and attaches them automatically to every later request —
     including the WebSocket handshake, which is a plain HTTP request before
     it upgrades. So when basic auth is configured, connect() fires one
     priming request (http.js's /v1/about call, which already sends the
     header) and only opens the socket after it settles. */

  var sock = null;
  var attempts = 0;
  var reconnectTimer = null;
  var wanted = false;
  var authPrimed = false;
  var priming = false;

  function state() {
    if (sock && sock.readyState === WebSocket.OPEN) return 'open';
    if (sock && sock.readyState === WebSocket.CONNECTING) return 'connecting';
    return 'closed';
  }

  function connect() {
    wanted = true;
    if (!App.config.isConfigured() || priming) return;
    if (sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (App.config.hasBasicAuth() && !authPrimed) {
      priming = true;
      App.util.dbg('ws: priming HTTP auth cache before connecting');
      App.api.about().then(function () {
        authPrimed = true;
      })['catch'](function (e) {
        App.util.dbg('ws: auth priming request failed — ' + e.message);
        // Try the socket anyway; some setups may not need this.
      }).then(function () {
        priming = false;
        if (wanted) openSocket();
      });
      return;
    }

    openSocket();
  }

  function openSocket() {
    var url = App.config.wsUrl() + '/v1/receive/' +
      encodeURIComponent(App.config.number());
    App.util.dbg('ws: connecting ' + url);
    App.store.setConnection('connecting');

    try {
      sock = new WebSocket(url);
    } catch (e) {
      App.util.dbg('ws: constructor failed ' + e.message);
      scheduleReconnect();
      return;
    }

    sock.onopen = function () {
      attempts = 0;
      App.util.dbg('ws: open');
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
      App.store.ingestRaw(frame);
    };

    sock.onclose = function () {
      App.util.dbg('ws: closed');
      App.store.setConnection('closed');
      sock = null;
      if (wanted) scheduleReconnect();
    };

    sock.onerror = function () {
      App.util.dbg('ws: error');
      // onclose follows and handles the reconnect.
    };
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
    authPrimed = false; // server URL or credentials may have just changed
    connect();
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && wanted && state() === 'closed') {
      attempts = 0;
      connect();
    }
  });

  App.ws = {
    connect: connect,
    stop: stop,
    restart: restart,
    state: state
  };
})();
