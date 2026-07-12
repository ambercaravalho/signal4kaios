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

  function write(c) {
    localStorage.setItem(KEY, JSON.stringify(c));
  }

  App.config = {
    get: read,

    set: function (patch) {
      var c = Object.assign(read(), patch);
      write(c);
    },

    serverUrl: function () {
      return (read().serverUrl || '').replace(/\/+$/, '');
    },

    number: function () {
      return read().number || '';
    },

    authUser: function () {
      return read().authUser || '';
    },

    authPass: function () {
      return read().authPass || '';
    },

    hasBasicAuth: function () {
      return !!App.config.authUser();
    },

    /* Feature flags. Boolean flags default to their most common value when the
       key is absent so existing installs keep their current behavior. */
    sendReadReceipts: function () {
      return read().sendReadReceipts !== false;
    },

    isConfigured: function () {
      return !!(App.config.serverUrl() && App.config.number());
    },

    wsUrl: function () {
      return App.config.serverUrl().replace(/^http/, 'ws');
    },

    /* ---- Multi-account ----
       The active account's credentials live at the top level (so all the
       accessors above keep working); `accounts` holds every saved account so
       the user can switch between them. Each account has its own IndexedDB. */

    accounts: function () {
      return read().accounts || [];
    },

    /* One-time migration: fold a pre-multi-account config into the accounts
       list. The existing account keeps the legacy (un-suffixed) database so no
       history is lost. */
    ensureAccounts: function () {
      var c = read();
      if (c.accounts) return;
      if (c.number) {
        c.accounts = [{
          number: c.number,
          serverUrl: c.serverUrl || '',
          authUser: c.authUser || '',
          authPass: c.authPass || '',
          legacyDb: true
        }];
      } else {
        c.accounts = [];
      }
      write(c);
    },

    /* Whether the active account uses the legacy (un-suffixed) database name. */
    activeUsesLegacyDb: function () {
      var accounts = read().accounts || [];
      var num = App.config.number();
      for (var i = 0; i < accounts.length; i++) {
        if (accounts[i].number === num && accounts[i].legacyDb) return true;
      }
      return false;
    },

    /* Insert or update the active account in the accounts list. */
    saveActiveAccount: function () {
      var c = read();
      c.accounts = c.accounts || [];
      var entry = {
        number: c.number || '',
        serverUrl: c.serverUrl || '',
        authUser: c.authUser || '',
        authPass: c.authPass || ''
      };
      var found = false;
      for (var i = 0; i < c.accounts.length; i++) {
        if (c.accounts[i].number === entry.number) {
          entry.legacyDb = c.accounts[i].legacyDb;
          c.accounts[i] = entry;
          found = true;
          break;
        }
      }
      if (!found) c.accounts.push(entry);
      write(c);
    },

    /* Make a saved account active. Caller should reload so the correct
       IndexedDB and WebSocket connection are used. */
    switchAccount: function (number) {
      var c = read();
      var accounts = c.accounts || [];
      for (var i = 0; i < accounts.length; i++) {
        if (accounts[i].number === number) {
          c.serverUrl = accounts[i].serverUrl || '';
          c.number = accounts[i].number || '';
          c.authUser = accounts[i].authUser || '';
          c.authPass = accounts[i].authPass || '';
          write(c);
          return true;
        }
      }
      return false;
    }
  };
})();
