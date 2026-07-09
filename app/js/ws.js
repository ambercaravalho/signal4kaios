(function () {
  'use strict';

  /* WebSocket manager for ws://<server>/v1/receive/<number> (json-rpc mode).
     Reconnects with exponential backoff + jitter; also reconnects when the
     app returns to the foreground. */

  var sock = null;
  var attempts = 0;
  var reconnectTimer = null;
  var wanted = false;

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
