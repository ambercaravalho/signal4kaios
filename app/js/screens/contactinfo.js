(function () {
  'use strict';

  /* Actions for a direct conversation: set the contact's nickname, change the disappearing-message timer, block or unblock, and view the safety number. create(conv) */

  App.screens.contactinfo = {
    create: function (conv) {
      var contact = App.store.contactByKey(conv.id);
      var recipient = (contact && contact.number) || conv.id;

      function setBlocked(blocked) {
        var call = blocked ? App.api.blockContact(recipient) : App.api.unblockContact(recipient);
        call.then(function () {
          App.toast(blocked ? 'Blocked' : 'Unblocked');
          if (blocked) App.store.setArchived(conv.id, true);
        })['catch'](function (err) {
          App.toast((blocked ? 'Block' : 'Unblock') + ' failed: ' + err.message);
        });
      }

      function block() {
        App.dialog.confirm({
          title: 'Block ' + (conv.name || recipient) + '?',
          message: 'Blocked people can\u2019t call or message you. This applies to all your devices.',
          confirmLabel: 'Block',
          onConfirm: function () { setBlocked(true); }
        });
      }

      function rename() {
        App.router.push(App.screens.textinput.create({
          title: 'Rename',
          label: 'Name',
          value: conv.name || '',
          placeholder: 'Contact name',
          submitLabel: 'Save',
          onSubmit: function (value, done) {
            if (!value) { done('Name cannot be empty'); return 'async'; }
            App.api.updateContact(recipient, value).then(function () {
              App.store.setConversationName(conv.id, value);
              return App.store.refreshDirectory()['catch'](function () { /* offline ok */ });
            }).then(function () {
              App.toast('Contact renamed');
              done();
            })['catch'](function (err) {
              done(err.message || 'Rename failed');
            });
            return 'async';
          }
        }));
      }

      function disappearing() {
        App.valueSelector.open({
          title: 'Disappearing messages',
          selected: App.store.convExpire(conv.id),
          options: App.util.EXPIRE_OPTIONS.map(function (opt) {
            return { label: opt.label, value: opt.secs };
          }),
          onPick: function (secs) {
            App.api.updateContact(recipient, null, secs).then(function () {
              App.store.setConvExpire(conv.id, secs);
              App.toast('Disappearing messages: ' + App.util.expireLabel(secs));
            })['catch'](function (err) {
              App.toast('Update failed: ' + err.message);
            });
          }
        });
      }

      return App.screens.menu.create({
        title: conv.name || 'Contact',
        items: [
          {
            label: 'Rename contact',
            hint: conv.name || recipient,
            onSelect: rename
          },
          {
            label: 'Disappearing messages',
            hint: App.util.expireLabel(App.store.convExpire(conv.id)),
            onSelect: disappearing
          },
          {
            label: 'Safety number',
            hint: 'Verify this contact',
            onSelect: function () {
              App.router.push(App.screens.safety.create({
                number: contact && contact.number,
                uuid: (contact && contact.uuid) || conv.id
              }));
            }
          },
          contact && contact.blocked
            ? { label: 'Unblock', hint: 'Allow messages and calls', onSelect: function () { setBlocked(false); } }
            : { label: 'Block', hint: 'Stop messages and calls', onSelect: block }
        ]
      });
    }
  };
})();
