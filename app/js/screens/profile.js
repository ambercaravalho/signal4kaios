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
          }
        ]
      });
    }
  };
})();
