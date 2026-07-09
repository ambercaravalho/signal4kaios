(function () {
  'use strict';

  var PRUNE_KEEP = 500; // messages kept per conversation

  function boot() {
    App.util.dbg('boot');
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
