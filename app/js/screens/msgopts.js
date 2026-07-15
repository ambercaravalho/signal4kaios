(function () {
  'use strict';

  /* Per-message actions menu, built on the generic menu screen.
     callbacks: { reply(rec), copy(rec), edit(rec) } — provided by the chat
     screen. */

  /* Compact URL for a menu label/hint: drop the scheme and clip the length. */
  function shortUrl(u) {
    var s = u.replace(/^https?:\/\//, '');
    return s.length > 38 ? s.slice(0, 37) + '…' : s;
  }

  App.screens.msgopts = {
    create: function (rec, callbacks) {
      var conv = App.store.conversation(rec.convId);

      // Items are collected into groups; headers are only rendered when more
      // than one group ends up with content (see assembly at the end).
      var openGrp = [];    // view / open the message content
      var actionGrp = [];  // react, reply, copy, pin
      var manageGrp = [];  // edit, retry, delete
      var detailGrp = [];  // reactions list + info

      if (!rec.deleted && rec.attachments && rec.attachments.length && rec.attachments[0].id) {
        var attType = rec.attachments[0].contentType || '';
        var attVerb = attType.indexOf('image/') === 0 ? 'View photo'
          : attType.indexOf('video/') === 0 ? 'Play video'
          : attType.indexOf('audio/') === 0 ? 'Play audio'
          : 'View attachment';
        openGrp.push({
          label: attVerb,
          onSelect: function () {
            App.router.replace(App.screens.viewer.create(rec.attachments[0]));
            return 'keep'; // replace() already removed this menu
          }
        });
      }

      if (!rec.deleted && rec.body && rec.body.length > 200) {
        openGrp.push({
          label: 'View full message',
          onSelect: function () {
            App.router.replace(App.screens.msgview.create(rec));
            return 'keep'; // replace() already removed this menu
          }
        });
      }

      // Any links in the body become "Open link" actions (they open in the
      // browser). Messages are the D-pad unit in the chat list, so surfacing
      // links here is how they become clickable.
      if (!rec.deleted && rec.body) {
        var urls = App.util.extractUrls(rec.body);
        if (urls.length === 1) {
          openGrp.push({
            label: 'Open link',
            hint: shortUrl(urls[0]),
            onSelect: function () { App.util.openUrl(urls[0]); }
          });
        } else {
          urls.forEach(function (u) {
            openGrp.push({
              label: 'Open ' + shortUrl(u),
              onSelect: function () { App.util.openUrl(u); }
            });
          });
        }
      }

      if (!rec.deleted) {
        actionGrp.push({
          label: 'React',
          onSelect: function () {
            App.router.replace(App.screens.reactions.create(rec));
            return 'keep'; // replace() already removed this menu
          }
        });
        actionGrp.push({
          label: 'Reply',
          onSelect: function () { callbacks.reply(rec); }
        });
        if (rec.body) {
          actionGrp.push({
            label: 'Copy to composer',
            onSelect: function () { callbacks.copy(rec); }
          });
        }
        // Pinned messages are a group-only Signal feature; they sync to the
        // whole group via the pin-message endpoint.
        if (conv && conv.type === 'group') {
          if (rec.pinned) {
            actionGrp.push({
              label: 'Unpin message',
              onSelect: function () {
                App.store.setPinned(rec, false).then(function () {
                  App.toast('Unpinned');
                })['catch'](function (err) {
                  App.toast('Unpin failed: ' + err.message);
                });
              }
            });
          } else {
            actionGrp.push({
              label: 'Pin message',
              onSelect: function () {
                App.store.setPinned(rec, true).then(function () {
                  App.toast('Pinned for everyone');
                })['catch'](function (err) {
                  App.toast('Pin failed: ' + err.message);
                });
              }
            });
          }
        }
      }

      if (!rec.incoming && !rec.deleted && rec.body &&
        (rec.status === 'sent' || rec.status === 'delivered' || rec.status === 'read')) {
        manageGrp.push({
          label: 'Edit message',
          onSelect: function () { callbacks.edit(rec); }
        });
      }

      if (rec.status === 'failed') {
        manageGrp.push({
          label: 'Retry send',
          onSelect: function () {
            App.store.retryMessage(rec)['catch'](function (err) {
              App.toast('Send failed: ' + err.message);
            });
          }
        });
      }

      if (!rec.incoming && !rec.deleted && rec.status !== 'failed' && rec.status !== 'pending') {
        manageGrp.push({
          label: 'Delete for everyone',
          onSelect: function () {
            App.dialog.confirm({
              title: 'Delete for everyone?',
              message: 'This removes the message for all chat participants.',
              confirmLabel: 'Delete',
              onConfirm: function () {
                App.router.pop(); // close this options menu
                App.store.deleteForEveryone(rec).then(function () {
                  App.toast('Message deleted');
                })['catch'](function (err) {
                  App.toast('Delete failed: ' + err.message);
                });
              }
            });
            return 'keep';
          }
        });
      }

      var reactorKeys = rec.reactions ? Object.keys(rec.reactions) : [];
      if (reactorKeys.length) {
        detailGrp.push({
          label: 'Reactions (' + reactorKeys.length + ')',
          onSelect: function () {
            App.router.replace(reactionsDetail(rec));
            return 'keep'; // replace() already removed this menu
          }
        });
      }

      var infoHint = App.util.fmtTimeFull(rec.timestamp) + ' · ' + rec.status;
      if (rec.expiresAt) {
        var remain = (rec.expiresAt - Date.now()) / 1000;
        infoHint += ' · disappears in ' + App.util.fmtDuration(remain);
      }
      detailGrp.push({
        label: 'Info',
        hint: infoHint,
        onSelect: function () { return 'keep'; }
      });

      var groups = [
        { title: 'Open', items: openGrp },
        { title: 'Actions', items: actionGrp },
        { title: 'Manage', items: manageGrp },
        { title: 'Details', items: detailGrp }
      ].filter(function (g) { return g.items.length; });

      // Headers only help when there's more than one section to separate.
      var multi = groups.length > 1;
      var items = [];
      groups.forEach(function (g) {
        if (multi) items.push({ section: g.title });
        g.items.forEach(function (it) { items.push(it); });
      });

      return App.screens.menu.create({ title: 'Message', items: items });
    }
  };

  /* A read-only list of who reacted and with which emoji. */
  function reactionsDetail(rec) {
    var self = App.store.selfNumber();
    var reactions = rec.reactions || {};
    var items = Object.keys(reactions).map(function (reactor) {
      var who = reactor === self ? 'You' : App.store.displayName(reactor);
      return {
        label: reactions[reactor] + '  ' + who,
        onSelect: function () { return 'keep'; }
      };
    });
    if (!items.length) {
      items.push({ label: 'No reactions', onSelect: function () { return 'keep'; } });
    }
    return App.screens.menu.create({ title: 'Reactions', items: items });
  }
})();
