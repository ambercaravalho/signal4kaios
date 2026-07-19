(function () {
  'use strict';

  var PRUNE_KEEP = 500; // messages kept per conversation

  /* Bring a conversation to the foreground — used by notification clicks.
     No-op if that chat is already on top of the stack. */
  App.openConversation = function (convId) {
    if (!convId) return;
    var cur = App.router.top();
    if (cur && cur.el && cur.el.getAttribute('data-conv-id') === convId) return;
    App.router.push(App.screens.chat.create(convId));
  };

  /* KaiOS 3.0+ only (3.0/3.1/4.0): register the ServiceWorker that relays wake alarms and
     notification clicks. 2.5 has no ServiceWorker (App.platform.hasServiceWorker
     is false there), so this is skipped and the mozSetMessageHandler path in
     ws.js handles wake alarms instead. */
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
    App.config.ensureAuthMode();
    App.config.ensureAccounts();
    registerServiceWorker();
    App.router.init(document.getElementById('screens'));

    // Surface connection drops as a top-of-screen in-app notice (distinct from
    // the transient toast). Only fire on an actual open -> offline transition.
    var lastConn = null;
    App.store.on('connection', function (state) {
      if (state === 'offline' && lastConn === 'open') {
        App.notice.show('Connection lost', 'Trying to reconnect\u2026', { icon: '!' });
      } else if (state === 'open' && lastConn === 'offline') {
        App.notice.hide();
      }
      lastConn = state;
    });

    if (App.config.isConfigured()) {
      App.router.push(App.screens.conversations.create());
    } else {
      App.router.push(App.screens.serversettings.create({ firstRun: true }));
    }

    App.store.init().then(function () {
      // Prune old history in the background after startup.
      setTimeout(function () {
        App.store.conversations().forEach(function (c) {
          App.db.pruneConversation(c.id, PRUNE_KEEP);
        });
      }, 5000);
    });

    // If background push is enabled, re-assert the subscription with the bridge
    // (endpoints can change across reboots/updates). Best-effort, non-blocking.
    if (App.push) App.push.sync();
  }

  window.addEventListener('load', boot);
})();
