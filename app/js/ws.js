(function () {
  'use strict';

  /* WebSocket manager for ws://<server>/v1/receive/<number> (json-rpc mode).
     Reconnects with exponential backoff + jitter; also reconnects when the
     app returns to the foreground.

     Basic-auth limitation (no client-side fix exists): browsers refuse both
     custom WebSocket handshake headers and userinfo (user:pass@) in ws://
     URLs, so this code can never attach an Authorization header to the
     handshake. An earlier version of this file tried to work around that by
     priming Gecko's HTTP auth cache with a prior XHR, on the theory that the
     cache would carry over to the handshake — confirmed by testing against a
     Traefik-based proxy (Pangolin's "header auth") that it does not. Basic
     Auth middlewares are typically stateless and check every single request
     independently, including the WS upgrade request, and there is no
     browser API that lets a WebSocket client satisfy that. If auth is
     failing only for the socket while plain HTTP calls succeed, the fix has
     to happen on the proxy: exempt the /v1/receive path from Basic Auth
     (e.g. a separate Pangolin resource/rule for it), and if it still needs
     protection, use a network-level control instead (IP allowlist, or the
     fact that it's already behind the tunnel) — see the README. */

  var sock = null;
  var attempts = 0;
  var reconnectTimer = null;
  var wanted = false;
  var opened = false;
  var warnedAuth = false;
  var everConnected = false; // have we had at least one successful open?
  var lastCloseAt = 0;       // when the socket last dropped (for gap logging)
  var framesThisSession = 0; // frames received since the current open

  function state() {
    if (sock && sock.readyState === WebSocket.OPEN) return 'open';
    if (sock && sock.readyState === WebSocket.CONNECTING) return 'connecting';
    return 'closed';
  }

  function connect() {
    wanted = true;
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
    App.util.dbg('ws: connecting ' + url);
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
      } else {
        App.util.dbg('ws: open');
      }
      everConnected = true;
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

      // A handshake that's rejected (e.g. a 401 from Basic Auth) closes
      // immediately without ever opening — that pattern, with Basic Auth
      // configured, is the one thing the app can actually detect here.
      if (!opened && App.config.hasBasicAuth() && Date.now() - startedAt < 5000) {
        App.util.dbg('ws: closed before opening with Basic Auth configured — ' +
          'the proxy is likely rejecting the handshake (see README: ' +
          'Basic Auth cannot authenticate a WebSocket in any browser)');
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

  App.ws = {
    connect: connect,
    stop: stop,
    restart: restart,
    state: state
  };
})();
