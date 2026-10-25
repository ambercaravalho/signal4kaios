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

    /* The device token from pairing with the gateway. Sent on every request (Authorization: Bearer on HTTP, a subprotocol on the WebSocket). SECURITY-REVIEW: a long-lived credential; never log it. */
    deviceToken: function () {
      return read().deviceToken || '';
    },

    /* Signal username and its shareable link (from the set-username endpoint). Cached here because the REST API has no GET for the current username. */
    username: function () {
      return read().username || '';
    },

    usernameLink: function () {
      return read().usernameLink || '';
    },

    /* Profile name and about text. The REST API has no GET for your own profile, so we remember what was last set here to pre-fill the editors and to satisfy the API (which requires a name on every profile update). */
    profileName: function () {
      return read().profileName || '';
    },

    profileAbout: function () {
      return read().profileAbout || '';
    },

    /* UI theme: 'light' (default, native KaiOS look) or 'dark' (Signal dark). Applied by App.theme on boot. */
    theme: function () {
      return read().theme || 'light';
    },

    /* Feature flags. Boolean flags default to their most common value when the key is absent so existing installs keep their current behavior. */
    sendReadReceipts: function () {
      return read().sendReadReceipts !== false;
    },

    /* Interpret *bold* / _italic_ style markers when sending. On by default. */
    styledText: function () {
      return read().styledText !== false;
    },

    /* Send typing indicators while composing. On by default. */
    typingIndicators: function () {
      return read().typingIndicators !== false;
    },

    /* Keep muted chats archived when new activity arrives (matches Signal). On by default; when off, muted chats unarchive like any other chat. */
    keepMutedArchived: function () {
      return read().keepMutedArchived !== false;
    },

    isConfigured: function () {
      return !!(App.config.serverUrl() && App.config.number() && App.config.deviceToken());
    },

    wsUrl: function () {
      return App.config.serverUrl().replace(/^http/, 'ws');
    },

    /* ---- Multi-account ----
       The active account's credentials live at the top level (so all the accessors above keep working); `accounts` holds every saved account so the user can switch between them. Each account has its own IndexedDB. */

    accounts: function () {
      return read().accounts || [];
    },

    /* The device token already paired with this gateway (from any saved account), so adding a second number on the same server needs no code. */
    tokenForServer: function (serverUrl) {
      var url = (serverUrl || '').replace(/\/+$/, '');
      var accounts = read().accounts || [];
      for (var i = 0; i < accounts.length; i++) {
        if (accounts[i].serverUrl === url && accounts[i].deviceToken) {
          return accounts[i].deviceToken;
        }
      }
      return '';
    },

    /* Insert or update the active account in the accounts list. */
    saveActiveAccount: function () {
      var c = read();
      c.accounts = c.accounts || [];
      var entry = {
        number: c.number || '',
        serverUrl: c.serverUrl || '',
        deviceToken: c.deviceToken || ''
      };
      var found = false;
      for (var i = 0; i < c.accounts.length; i++) {
        if (c.accounts[i].number === entry.number) {
          c.accounts[i] = entry;
          found = true;
          break;
        }
      }
      if (!found) c.accounts.push(entry);
      write(c);
    },

    /* Set the device token for a gateway on the active config and every saved account on that server (one pairing covers all its numbers). */
    setServerToken: function (serverUrl, token) {
      var c = read();
      var url = (serverUrl || '').replace(/\/+$/, '');
      if ((c.serverUrl || '') === url) c.deviceToken = token || '';
      (c.accounts || []).forEach(function (a) {
        if (a.serverUrl === url) a.deviceToken = token || '';
      });
      write(c);
    },

    /* Drop the pairing for a gateway (after unpairing or a 401). */
    forgetPairing: function (serverUrl) {
      App.config.setServerToken(serverUrl, '');
    },

    /* Make a saved account active. Caller should reload so the correct IndexedDB and WebSocket connection are used. */
    switchAccount: function (number) {
      var c = read();
      var accounts = c.accounts || [];
      for (var i = 0; i < accounts.length; i++) {
        if (accounts[i].number === number) {
          c.serverUrl = accounts[i].serverUrl || '';
          c.number = accounts[i].number || '';
          c.deviceToken = accounts[i].deviceToken || '';
          write(c);
          return true;
        }
      }
      return false;
    }
  };
})();
