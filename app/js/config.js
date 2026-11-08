(function () {
  'use strict';

  var KEY = 's4k.config';
  var DEFAULT_SIGNAL_SERVER = 'https://chat.signal.org';

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
      return (read().serverUrl || DEFAULT_SIGNAL_SERVER).replace(/\/+$/, '');
    },

    number: function () {
      return read().number || '';
    },

    aci: function () {
      return read().aci || '';
    },

    deviceId: function () {
      return read().deviceId || 0;
    },

    /* Signal device signaling password from linking. Stored locally in config/IndexedDB; never logged. */
    deviceToken: function () {
      return read().deviceToken || '';
    },

    /* Signal username and its shareable link (from the set-username endpoint). */
    username: function () {
      return read().username || '';
    },

    usernameLink: function () {
      return read().usernameLink || '';
    },

    /* Profile name and about text. */
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
      var c = read();
      return !!((c.number || c.aci) && c.deviceToken && c.deviceId);
    },

    wsUrl: function () {
      return App.config.serverUrl().replace(/^http/, 'ws');
    },

    /* ---- Multi-account ----
       The active account's credentials live at the top level; `accounts` holds every saved account so the user can switch between them. Each account has its own IndexedDB. */

    accounts: function () {
      return read().accounts || [];
    },

    /* Insert or update the active account in the accounts list. */
    saveActiveAccount: function () {
      var c = read();
      c.accounts = c.accounts || [];
      var entry = {
        number: c.number || '',
        aci: c.aci || '',
        deviceId: c.deviceId || 0,
        serverUrl: c.serverUrl || DEFAULT_SIGNAL_SERVER,
        deviceToken: c.deviceToken || ''
      };
      var found = false;
      for (var i = 0; i < c.accounts.length; i++) {
        if (c.accounts[i].number === entry.number || (entry.aci && c.accounts[i].aci === entry.aci)) {
          c.accounts[i] = entry;
          found = true;
          break;
        }
      }
      if (!found) c.accounts.push(entry);
      write(c);
    },

    /* Drop the linked device credentials for the active account (after unlinking or a 401). */
    forgetPairing: function () {
      var c = read();
      var activeNum = c.number;
      var activeAci = c.aci;
      c.deviceToken = '';
      c.deviceId = 0;
      c.accounts = (c.accounts || []).filter(function (a) {
        return a.number !== activeNum && (!activeAci || a.aci !== activeAci);
      });
      write(c);
    },

    /* Make a saved account active. Caller should reload so the correct IndexedDB and WebSocket connection are used. */
    switchAccount: function (number) {
      var c = read();
      var accounts = c.accounts || [];
      for (var i = 0; i < accounts.length; i++) {
        if (accounts[i].number === number) {
          c.serverUrl = accounts[i].serverUrl || DEFAULT_SIGNAL_SERVER;
          c.number = accounts[i].number || '';
          c.aci = accounts[i].aci || '';
          c.deviceId = accounts[i].deviceId || 0;
          c.deviceToken = accounts[i].deviceToken || '';
          write(c);
          return true;
        }
      }
      return false;
    }
  };
})();
