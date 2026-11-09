(function () {
  'use strict';

  /* Edit this account's Signal profile via App.api.updateProfile (encrypted and uploaded on-device) and its username via App.api.setUsername / deleteUsername.

     The editors pre-fill from what was last set on this device (cached in config) and, for the name, fall back to this account's own entry in the synced contacts. A Signal profile always carries a name, so `name` is sent with every update. */

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

  /* Send the profile, always including the name (a profile without a name is rejected). `patch` overrides one field; the rest come from cache. `about` is only sent when the user edited it or we have a cached value, so a name-only edit never blanks an about that was set from another device. */
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

  /* Reserve a Signal username. A bare nickname gets a random number (`name.42`); typing the number picks it. App.api.setUsername also saves the username and its link to config. `then(res)` runs after the editor closes. */
  function editUsername(then) {
    App.router.push(App.screens.textinput.create({
      title: 'Signal username',
      label: 'Username',
      placeholder: 'yourname or yourname.42',
      value: App.config.username(),
      submitLabel: 'Save',
      onSubmit: function (value, done) {
        var v = value.replace(/^\s+|\s+$/g, '').replace(/^@/, '');
        if (!v) { done('Enter a username'); return 'async'; }
        App.api.setUsername(v).then(function (res) {
          done();
          App.toast('Username set to @' + res.username);
          if (then) then(res);
        })['catch'](function (err) {
          done(err.message || 'Could not set username');
        });
        return 'async';
      }
    }));
  }

  function deleteUsername() {
    App.dialog.confirm({
      title: 'Delete username?',
      message: 'Your username and QR code link stop working. Anyone can claim the username afterwards.',
      confirmLabel: 'Delete',
      onConfirm: function () {
        App.api.deleteUsername().then(function () {
          App.toast('Username deleted');
        })['catch'](function (err) {
          App.toast('Delete failed: ' + err.message);
        });
      }
    });
  }

  /* Show the QR code for this account's Signal username link, asking for a username first if there is none. */
  function showQr() {
    var link = App.config.usernameLink();
    if (link) {
      App.router.push(App.screens.qrcode.create(link));
      return;
    }
    editUsername(function (res) {
      App.router.push(App.screens.qrcode.create(res.username_link));
    });
  }

  App.screens.profile = {
    /* Exposed so other screens (e.g. Settings) can jump straight to the QR. */
    showQr: showQr,

    create: function () {
      var name = currentName();
      var about = currentAbout();
      var uname = App.config.username();
      var items = [
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
          label: 'Username',
          hint: uname ? '@' + uname : 'Set a username',
          onSelect: function () { editUsername(); }
        },
        {
          label: 'My QR code',
          hint: 'Share your username link',
          onSelect: function () { showQr(); return 'keep'; }
        }
      ];
      if (uname) {
        items.push({
          label: 'Delete username',
          onSelect: function () { deleteUsername(); return 'keep'; }
        });
      }
      return App.screens.menu.create({ title: 'Edit profile', items: items });
    }
  };
})();
