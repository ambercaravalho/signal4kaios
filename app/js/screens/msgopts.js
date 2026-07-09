(function () {
  'use strict';

  /* Per-message actions menu, built on the generic menu screen.
     callbacks: { reply(rec), copy(rec), edit(rec) } — provided by the chat
     screen. */

  App.screens.msgopts = {
    create: function (rec, callbacks) {
      var items = [];

      if (!rec.deleted && rec.attachments && rec.attachments.length && rec.attachments[0].id) {
        items.push({
          label: 'View ' + ((rec.attachments[0].contentType || '').indexOf('image/') === 0
            ? 'photo' : 'attachment'),
          onSelect: function () {
            App.router.replace(App.screens.viewer.create(rec.attachments[0]));
            return 'keep'; // replace() already removed this menu
          }
        });
      }

      if (!rec.deleted) {
        items.push({
          label: 'React',
          onSelect: function () {
            App.router.replace(App.screens.reactions.create(rec));
            return 'keep'; // replace() already removed this menu
          }
        });
        items.push({
          label: 'Reply',
          onSelect: function () { callbacks.reply(rec); }
        });
        if (rec.body) {
          items.push({
            label: 'Copy to composer',
            onSelect: function () { callbacks.copy(rec); }
          });
        }
      }

      if (!rec.incoming && !rec.deleted && rec.body &&
        (rec.status === 'sent' || rec.status === 'delivered' || rec.status === 'read')) {
        items.push({
          label: 'Edit message',
          onSelect: function () { callbacks.edit(rec); }
        });
      }

      if (rec.status === 'failed') {
        items.push({
          label: 'Retry send',
          onSelect: function () {
            App.store.retryMessage(rec)['catch'](function (err) {
              App.toast('Send failed: ' + err.message);
            });
          }
        });
      }

      if (!rec.incoming && !rec.deleted && rec.status !== 'failed' && rec.status !== 'pending') {
        items.push({
          label: 'Delete for everyone',
          onSelect: function () {
            App.store.deleteForEveryone(rec).then(function () {
              App.toast('Message deleted');
            })['catch'](function (err) {
              App.toast('Delete failed: ' + err.message);
            });
          }
        });
      }

      items.push({
        label: 'Info',
        hint: App.util.fmtTimeFull(rec.timestamp) + ' · ' + rec.status,
        onSelect: function () { return 'keep'; }
      });

      return App.screens.menu.create({ title: 'Message', items: items });
    }
  };
})();
