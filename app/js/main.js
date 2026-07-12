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
    App.config.ensureAccounts();
    App.router.init(document.getElementById('screens'));

    if (App.config.isConfigured()) {
      App.router.push(App.screens.conversations.create());
    } else {
      App.router.push(App.screens.settings.create({ firstRun: true }));
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
