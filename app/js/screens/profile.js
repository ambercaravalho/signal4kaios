(function () {
  'use strict';

  /* Edit this account's Signal profile via PUT /v1/profiles/{number}. The REST
     API exposes no GET for your own profile, so fields start blank and only the
     value you enter is sent. */

  function editField(label, key, placeholder) {
    App.router.push(App.screens.textinput.create({
      title: 'Profile',
      label: label,
      placeholder: placeholder,
      submitLabel: 'Save',
      onSubmit: function (value, done) {
        var patch = {};
        patch[key] = value;
        App.api.updateProfile(patch).then(function () {
          App.toast('Profile updated');
          done();
        })['catch'](function (err) {
          done(err.message || 'Update failed');
        });
        return 'async';
      }
    }));
  }

  /* Show the QR code for this account's Signal username link. The REST API has
     no GET for the current username, so if none is cached we prompt to set one
     (the set-username endpoint returns the shareable link) and cache it. */
  function showQr() {
    var link = App.config.usernameLink();
    if (link) {
      App.router.push(App.screens.qrcode.create(link));
      return;
    }
    App.router.push(App.screens.textinput.create({
      title: 'Signal username',
      label: 'Username',
      placeholder: 'yourname',
      value: App.config.username(),
      submitLabel: 'Save',
      onSubmit: function (value, done) {
        var v = value.replace(/^\s+|\s+$/g, '');
        if (!v) { done('Enter a username'); return 'async'; }
        App.api.setUsername(v).then(function (res) {
          var newLink = res && res.username_link;
          App.config.set({
            username: (res && res.username) || v,
            usernameLink: newLink || ''
          });
          done();
          if (newLink) {
            App.router.push(App.screens.qrcode.create(newLink));
          } else {
            App.toast('Username set, but no link was returned');
          }
        })['catch'](function (err) {
          done(err.message || 'Could not set username');
        });
        return 'async';
      }
    }));
  }

  App.screens.profile = {
    create: function () {
      return App.screens.menu.create({
        title: 'Edit profile',
        items: [
          {
            label: 'Name',
            hint: 'Your display name',
            onSelect: function () { editField('Name', 'name', 'Your name'); }
          },
          {
            label: 'About',
            hint: 'Short status text',
            onSelect: function () { editField('About', 'about', 'About you'); }
          },
          {
            label: 'My QR code',
            hint: App.config.username() || 'Share your Signal link',
            onSelect: function () { showQr(); return 'keep'; }
          }
        ]
      });
    }
  };
})();
