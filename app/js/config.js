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

    /* Connection auth mode: how (if at all) requests are authenticated against a
       reverse proxy in front of the server. One of:
         'none'  - no credentials on any request (LAN / private VPN only).
         'basic' - HTTP Basic Auth header; the WebSocket is left unauthenticated.
         'token' - a single token sent as a query param on EVERY request (HTTP
                   and the WebSocket), so both the API and the receive path are
                   covered. See docs/remote-access.md. */
    authMode: function () {
      return read().authMode || 'none';
    },

    hasBasicAuth: function () {
      return App.config.authMode() === 'basic' && !!App.config.authUser();
    },

    /* Query-param name the receive token is sent as. Generic default 'token';
       set to 'p_token' for Pangolin (its default access-token param). */
    tokenParam: function () {
      return read().tokenParam || 'token';
    },

    /* Signal username and its shareable link (from the set-username endpoint).
       Cached here because the REST API has no GET for the current username. */
    username: function () {
      return read().username || '';
    },

    usernameLink: function () {
      return read().usernameLink || '';
    },

    /* The receive token (used when authMode is 'token'). Sent as a query param
       (see tokenParam) on every HTTP request and on the receive WebSocket URL,
       so a reverse proxy can authenticate both the API and the /v1/receive path
       with one secret. For Pangolin this is a Resource Access Token in
       <id>.<secret> form; set tokenParam to 'p_token'. See
       docs/remote-access.md. */
    receiveToken: function () {
      return read().receiveToken || '';
    },

    /* Profile name and about text. The REST API has no GET for your own
       profile, so we remember what was last set here to pre-fill the editors
       and to satisfy the API (which requires a name on every profile update). */
    profileName: function () {
      return read().profileName || '';
    },

    profileAbout: function () {
      return read().profileAbout || '';
    },

    /* UI theme: 'light' (default, native KaiOS look) or 'dark' (Signal dark).
       Applied by App.theme on boot. */
    theme: function () {
      return read().theme || 'light';
    },

    /* Feature flags. Boolean flags default to their most common value when the
       key is absent so existing installs keep their current behavior. */
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

    /* Keep muted chats archived when new activity arrives (matches Signal).
       On by default; when off, muted chats unarchive like any other chat. */
    keepMutedArchived: function () {
      return read().keepMutedArchived !== false;
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

    /* One-time migration: derive the auth mode for configs saved before modes
       existed. A receive token wins (the old mixed pipeline becomes token-only,
       and we keep p_token as the param so existing Pangolin setups keep working);
       otherwise a username means Basic Auth; otherwise unauthenticated. */
    ensureAuthMode: function () {
      var c = read();
      if (c.authMode) return;
      if (c.receiveToken) {
        c.authMode = 'token';
        if (!c.tokenParam) c.tokenParam = 'p_token';
      } else if (c.authUser) {
        c.authMode = 'basic';
      } else {
        c.authMode = 'none';
      }
      write(c);
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
          authMode: c.authMode || 'none',
          authUser: c.authUser || '',
          authPass: c.authPass || '',
          receiveToken: c.receiveToken || '',
          tokenParam: c.tokenParam || '',
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
        authMode: c.authMode || 'none',
        authUser: c.authUser || '',
        authPass: c.authPass || '',
        receiveToken: c.receiveToken || '',
        tokenParam: c.tokenParam || ''
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
          c.authMode = accounts[i].authMode || 'none';
          c.authUser = accounts[i].authUser || '';
          c.authPass = accounts[i].authPass || '';
          c.receiveToken = accounts[i].receiveToken || '';
          c.tokenParam = accounts[i].tokenParam || '';
          write(c);
          return true;
        }
      }
      return false;
    }
  };
})();
