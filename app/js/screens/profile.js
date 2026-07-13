(function () {
  'use strict';

  /* Edit this account's Signal profile via PUT /v1/profiles/{number}.

     The REST API exposes no GET for your own profile, so we can't read the live
     values back. Instead we pre-fill the editors from what was last set on this
     device (cached in config) and, for the name, fall back to this account's own
     entry in the contact directory when signal-cli includes it. The API also
     requires a non-empty name on every profile update, so `name` is always sent
     alongside `about`. */

  function currentName() {
    var cached = App.config.profileName();
    if (cached) return cached;
    var me = App.store.contactByKey(App.config.number());
    if (me && me.name && me.name !== App.config.number()) return me.name;
    return '';
  }

  function currentAbout() {
    return App.config.profileAbout();
  }

  /* Send the profile, always including the name (the API rejects updates with
     an empty name). `patch` overrides one field; the rest come from cache.
     `about` is only sent when the user edited it or we have a cached value, so a
     name-only edit never blanks an about that was set from another device. */
  function saveProfile(patch, done) {
    var name = ('name' in patch) ? patch.name : currentName();
    name = (name || '').replace(/^\s+|\s+$/g, '');
    if (!name) {
      done('Set your name first');
      return;
    }
    var payload = { name: name };
    if ('about' in patch) payload.about = patch.about;
    else if (currentAbout()) payload.about = currentAbout();

    App.api.updateProfile(payload).then(function () {
      var cache = { profileName: name };
      if ('about' in payload) cache.profileAbout = payload.about || '';
      App.config.set(cache);
      App.toast('Profile updated');
      done();
    })['catch'](function (err) {
      done(err.message || 'Update failed');
    });
  }

  function editName() {
    App.router.push(App.screens.textinput.create({
      title: 'Profile',
      label: 'Name',
      placeholder: 'Your name',
      value: currentName(),
      submitLabel: 'Save',
      onSubmit: function (value, done) {
        saveProfile({ name: value }, done);
        return 'async';
      }
    }));
  }

  function editAbout() {
    App.router.push(App.screens.textinput.create({
      title: 'Profile',
      label: 'About',
      placeholder: 'About you',
      value: currentAbout(),
      submitLabel: 'Save',
      onSubmit: function (value, done) {
        saveProfile({ about: value.replace(/^\s+|\s+$/g, '') }, done);
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
      var name = currentName();
      var about = currentAbout();
      var uname = App.config.username();
      return App.screens.menu.create({
        title: 'Edit profile',
        items: [
          {
            label: 'Name',
            hint: name || 'Set your display name',
            onSelect: function () { editName(); }
          },
          {
            label: 'About',
            hint: about || 'Set a short status',
            onSelect: function () { editAbout(); }
          },
          {
            label: 'My QR code',
            hint: uname ? '@' + uname : 'Share your Signal link',
            onSelect: function () { showQr(); return 'keep'; }
          }
        ]
      });
    }
  };
})();
