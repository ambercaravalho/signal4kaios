(function () {
  'use strict';

  /* Theme switching. The palette lives entirely in CSS custom properties on
     html[data-theme]; this module just flips the attribute and keeps the
     status-bar color (<meta name="theme-color">) in sync. Preference is stored
     in config (localStorage) via App.config.theme(). */

  /* Status-bar tint matches each theme's header bar: the deep-blue native
     header in light, the dark shell in dark. */
  var META_COLOR = { light: '#14224f', dark: '#1b1b1d' };

  function metaEl() {
    return document.querySelector('meta[name="theme-color"]');
  }

  /* Only two concrete themes exist; anything unknown resolves to the native
     light default. */
  function resolve(name) {
    return name === 'dark' ? 'dark' : 'light';
  }

  App.theme = {
    apply: function () {
      var t = resolve(App.config.theme());
      document.documentElement.setAttribute('data-theme', t);
      var m = metaEl();
      if (m) m.setAttribute('content', META_COLOR[t]);
    },

    set: function (name) {
      App.config.set({ theme: resolve(name) });
      App.theme.apply();
    },

    current: function () {
      return resolve(App.config.theme());
    }
  };
})();
