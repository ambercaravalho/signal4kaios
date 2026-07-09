(function () {
  'use strict';

  var KEY = 's4k.config';

  function read() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  App.config = {
    get: read,

    set: function (patch) {
      var c = Object.assign(read(), patch);
      localStorage.setItem(KEY, JSON.stringify(c));
    },

    serverUrl: function () {
      return (read().serverUrl || '').replace(/\/+$/, '');
    },

    number: function () {
      return read().number || '';
    },

    isConfigured: function () {
      return !!(App.config.serverUrl() && App.config.number());
    },

    wsUrl: function () {
      return App.config.serverUrl().replace(/^http/, 'ws');
    }
  };
})();
