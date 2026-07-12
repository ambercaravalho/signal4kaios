(function () {
  'use strict';

  /* Actions for a direct conversation: rename the saved contact (PUT
     /v1/contacts + /sync) and view its safety number. create(conv) */

  App.screens.contactinfo = {
    create: function (conv) {
      var contact = App.store.contactByKey(conv.id);
      var recipient = (contact && contact.number) || conv.id;

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
              return App.api.syncContacts()['catch'](function () { /* best effort */ });
            }).then(function () {
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
        var current = App.store.convExpire(conv.id);
        var items = App.util.EXPIRE_OPTIONS.map(function (opt) {
          return {
            label: opt.label + (opt.secs === current ? '  ✓' : ''),
            onSelect: function () {
              App.api.updateContact(recipient, null, opt.secs).then(function () {
                App.store.setConvExpire(conv.id, opt.secs);
                App.toast('Disappearing messages: ' + opt.label);
              })['catch'](function (err) {
                App.toast('Update failed: ' + err.message);
              });
            }
          };
        });
        App.router.push(App.screens.menu.create({
          title: 'Disappearing messages', items: items
        }));
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
              App.router.push(App.screens.safety.create({ number: recipient }));
            }
          }
        ]
      });
    }
  };
})();
