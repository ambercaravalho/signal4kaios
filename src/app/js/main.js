(function () {
  'use strict';

  var PRUNE_KEEP = 500; // messages kept per conversation

  /* Bring a conversation to the foreground — used by notification clicks. No-op if that chat is already on top of the stack. */
  App.openConversation = function (convId) {
    if (!convId) return;
    var cur = App.router.top();
    if (cur && cur.el && cur.el.getAttribute('data-conv-id') === convId) return;
    App.router.push(App.screens.chat.create(convId));
  };

  /* A notification tapped while the app was closed can't postMessage a live window, so sw.js stashes the target conversation in Cache Storage. Read it once on boot (fresh entries only, so an unrelated later launch still lands on the list), clear it, and open the chat. */
  function openPendingConversation() {
    if (typeof caches === 'undefined') return;
    caches.open('s4k-wake').then(function (cache) {
      return cache.match('/__s4k_pending_conv').then(function (res) {
        if (!res) return null;
        return res.json().then(function (info) {
          return cache['delete']('/__s4k_pending_conv').then(function () {
            return info;
          });
        });
      });
    }).then(function (info) {
      if (!info || !info.convId) return;
      // Ignore stale entries (>60s): the tap that set this should be recent.
      if (typeof info.ts === 'number' && Date.now() - info.ts > 60000) return;
      App.util.dbg('boot: opening conversation from notification');
      App.openConversation(info.convId);
    })['catch'](function (e) {
      App.util.dbg('boot: pending conversation read failed ' + (e && e.message));
    });
  }

  /* Register the ServiceWorker that relays wake alarms, shows closed-app notifications, and handles notification clicks. Feature-detected via App.platform.hasServiceWorker(), so it's a no-op in a desktop browser without one. */
  function registerServiceWorker() {
    if (!App.platform.hasServiceWorker()) return;
    try {
      navigator.serviceWorker.register('/sw.js').then(function () {
        App.util.dbg('sw: registered');
      })['catch'](function (e) {
        App.util.dbg('sw: registration failed ' + (e && e.message));
      });
      navigator.serviceWorker.addEventListener('message', function (evt) {
        var data = evt && evt.data;
        if (data && data.type === 's4k-open-conversation' && data.convId) {
          try { window.focus(); } catch (e2) { /* not focusable */ }
          App.openConversation(data.convId);
        }
      });
    } catch (e) {
      App.util.dbg('sw: unavailable ' + e.message);
    }
  }

  function boot() {
    App.util.dbg('boot');
    App.theme.apply();
    registerServiceWorker();
    App.router.init(document.getElementById('screens'));

    // Every Signal operation runs in the libsignal WebAssembly module, so nothing that touches App.signal may start until it has loaded.
    App.signal.ready().then(function (version) {
      App.util.dbg('libsignal ' + version + ' ready');
      return App.db.ready().then(function () {
        // A pre-libsignal database was upgraded and its protocol state discarded: the old link can't be used any more.
        if (App.db.signalStateWasReset() && App.config.isConfigured()) {
          App.util.dbg('boot: protocol state reset by the libsignal upgrade, relink required');
          App.config.forgetAccount();
        }
      }, function (e) {
        App.util.dbg('boot: database open failed ' + (e && e.message));
      }).then(start);
    }, function (err) {
      App.util.dbg('libsignal failed to load: ' + ((err && err.reason) || '') + ' ' + (err && err.message));
      App.router.push(App.screens.wasmerror.create(err));
    });
  }

  function start() {
    // Surface connection drops as a top-of-screen in-app notice (distinct from the transient toast). Only fire on an actual open -> offline transition.
    var lastConn = null;
    App.store.on('connection', function (state) {
      if (state === 'offline' && lastConn === 'open') {
        App.notice.show('Connection lost', 'Trying to reconnect\u2026', { icon: '!' });
      } else if (state === 'open' && lastConn === 'offline') {
        App.notice.hide();
      }
      lastConn = state;
    });

    // Signal server rejected our linked device credentials (unlinked from primary phone): forget the account and return to the Link screen.
    App.http.onUnlinked = function () {
      App.util.dbg('auth: linked device rejected, returning to link screen');
      App.ws.stop();
      App.config.forgetAccount();
      location.reload();
    };

    if (App.config.isConfigured()) {
      App.router.push(App.screens.conversations.create());
    } else if (App.config.number() || App.config.aci()) {
      // Linked before, but unlinked.
      App.router.push(App.screens.link.create({ firstRun: true, unlinked: true }));
    } else {
      App.router.push(App.screens.welcome.create({ firstRun: true }));
    }

    App.store.init().then(function () {
      // If the app was cold-started by a notification tap, route to that chat now that history is loaded.
      openPendingConversation();
      // Prune old history in the background after startup.
      setTimeout(function () {
        App.store.conversations().forEach(function (c) {
          App.db.pruneConversation(c.id, PRUNE_KEEP);
        });
      }, 5000);
    });

    // Re-arm closed-app wake on every start (KaiOS drops alarm subscriptions across reboots). Best-effort and non-blocking.
    if (App.wake) App.wake.sync();
  }

  window.addEventListener('load', boot);
})();
