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

  function boot() {
    App.util.dbg('boot');
    App.theme.apply();
    App.config.ensureAccounts();
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
  }

  window.addEventListener('load', boot);
})();
