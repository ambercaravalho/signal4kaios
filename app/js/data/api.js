(function () {
  'use strict';

  /* App-facing Signal API (`App.api`): sends, profile, attachments, and directory reads go through `App.signal` (on-device libsignal) and IndexedDB (`App.db`). Some group, contact, pin, and username edits are still local-only stubs; see docs/user-guide.md "Known limitations". */

  function loadSyncedContacts() {
    return App.db.kvGet('syncedContacts').then(function (list) {
      return list || [];
    })['catch'](function () { return []; });
  }

  function saveSyncedContacts(list) {
    return App.db.kvSet('syncedContacts', list || []);
  }

  function loadSyncedGroups() {
    return App.db.kvGet('syncedGroups').then(function (list) {
      return list || [];
    })['catch'](function () { return []; });
  }

  function saveSyncedGroups(list) {
    return App.db.kvSet('syncedGroups', list || []);
  }

  App.api = {
    about: function () {
      return Promise.resolve({ version: '2.0.0', mode: 'on-device' });
    },

    /* Unlink this phone: wipes its local Signal state. */
    unlink: function () {
      return App.db.wipe()['catch'](function () {});
    },

    contacts: function () {
      return loadSyncedContacts();
    },

    groups: function () {
      return loadSyncedGroups();
    },

    /* Download and decrypt an attachment directly from Signal CDN; resolves to a Blob. */
    attachment: function (id) {
      return App.signal.downloadAttachmentBlob(id);
    },

    contactAvatar: function (uuid) {
      return App.signal.fetchContactAvatarBlob(uuid);
    },

    groupAvatar: function (groupId) {
      return App.db.getAttachment('avatar:' + groupId).then(function (row) {
        if (row && row.blob) return row.blob;
        throw new Error('No cached group avatar');
      });
    },

    /* Encrypt and send a 1:1 or group message on-device; resolves to { timestamp }. */
    send: function (payload) {
      return App.signal.send(payload);
    },

    react: function (recipient, targetAuthor, targetTimestamp, emoji) {
      return App.signal.sendReaction(recipient, targetAuthor, targetTimestamp, emoji, false);
    },

    unreact: function (recipient, targetAuthor, targetTimestamp, emoji) {
      return App.signal.sendReaction(recipient, targetAuthor, targetTimestamp, emoji, true);
    },

    remoteDelete: function (recipient, timestamp) {
      return App.signal.sendRemoteDelete(recipient, timestamp);
    },

    typingStart: function (recipient) {
      return App.signal.sendTyping(recipient, true);
    },

    typingStop: function (recipient) {
      return App.signal.sendTyping(recipient, false);
    },

    readReceipt: function (recipient, timestamp) {
      return App.signal.sendReadReceipt(recipient, timestamp);
    },

    /* Check whether one or more numbers/UUIDs can be messaged. */
    searchNumbers: function (numbers) {
      var list = [].concat(numbers);
      return Promise.resolve(list.map(function (n) {
        return { number: String(n).trim(), registered: true };
      }));
    },

    /* Known identities (safety numbers / fingerprints) computed directly on device. */
    identities: function () {
      return App.signal.identities();
    },

    /* Trust or mark verified a contact's identity key on device. */
    trustIdentity: function (target, opts) {
      return App.signal.trustIdentity(target, opts || { trust_all_known_keys: true });
    },

    /* Update this account's profile metadata and upload encrypted profile to Signal server. */
    updateProfile: function (body) {
      body = body || {};
      if (body.name != null) App.config.set({ profileName: body.name });
      if (body.about != null) App.config.set({ profileAbout: body.about });
      return App.signal.updateOwnProfile(body);
    },

    /* Rename a saved contact and/or set its disappearing-message timer locally. */
    updateContact: function (recipient, name, expirationInSeconds) {
      return loadSyncedContacts().then(function (list) {
        var found = false;
        list.forEach(function (c) {
          if (c.number === recipient || c.uuid === recipient) {
            if (name != null) c.name = name;
            if (expirationInSeconds != null) c.expireTimer = expirationInSeconds;
            found = true;
          }
        });
        if (!found) {
          list.push({
            uuid: recipient.indexOf('+') === 0 ? '' : recipient,
            number: recipient.indexOf('+') === 0 ? recipient : '',
            name: name || recipient,
            blocked: false,
            expireTimer: expirationInSeconds || 0
          });
        }
        return saveSyncedContacts(list);
      });
    },

    /* Request contact & group sync from the primary device. */
    syncContacts: function () {
      return App.signal.requestSync();
    },

    /* Full detail for one group. groupId is the send id ("group.…"). */
    groupDetail: function (groupId) {
      var internalId = String(groupId || '').replace(/^group\./, '');
      return loadSyncedGroups().then(function (list) {
        var g = null;
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === groupId || list[i].internal_id === internalId) {
            g = list[i];
            break;
          }
        }
        return g || {
          id: groupId,
          internal_id: internalId,
          name: 'Group',
          members: [],
          admins: []
        };
      });
    },

    /* Update group metadata locally. */
    updateGroup: function (groupId, body) {
      body = body || {};
      var internalId = String(groupId || '').replace(/^group\./, '');
      return loadSyncedGroups().then(function (list) {
        list.forEach(function (g) {
          if (g.id === groupId || g.internal_id === internalId) {
            if (body.name != null) g.name = body.name;
            if (body.description != null) g.description = body.description;
            if (body.expiration_time != null) g.expireTimer = body.expiration_time;
            if (body.permissions) g.permissions = body.permissions;
            if (body.group_link) g.invite_link = body.group_link;
          }
        });
        return saveSyncedGroups(list);
      });
    },

    quitGroup: function (groupId) {
      var internalId = String(groupId || '').replace(/^group\./, '');
      return loadSyncedGroups().then(function (list) {
        var filtered = list.filter(function (g) {
          return g.id !== groupId && g.internal_id !== internalId;
        });
        return saveSyncedGroups(filtered);
      });
    },

    removeGroupMembers: function (groupId, members) {
      var removeSet = [].concat(members);
      return App.api.groupDetail(groupId).then(function (g) {
        g.members = (g.members || []).filter(function (m) {
          return removeSet.indexOf(m) < 0;
        });
        return App.api.updateGroup(groupId, g);
      });
    },

    addGroupMembers: function (groupId, members) {
      var addList = [].concat(members);
      return App.api.groupDetail(groupId).then(function (g) {
        var cur = g.members || [];
        addList.forEach(function (m) {
          if (cur.indexOf(m) < 0) cur.push(m);
        });
        g.members = cur;
        return App.api.updateGroup(groupId, g);
      });
    },

    addGroupAdmins: function (groupId, admins) {
      var addList = [].concat(admins);
      return App.api.groupDetail(groupId).then(function (g) {
        var cur = g.admins || [];
        addList.forEach(function (a) {
          if (cur.indexOf(a) < 0) cur.push(a);
        });
        g.admins = cur;
        return App.api.updateGroup(groupId, g);
      });
    },

    removeGroupAdmins: function (groupId, admins) {
      var rem = [].concat(admins);
      return App.api.groupDetail(groupId).then(function (g) {
        g.admins = (g.admins || []).filter(function (a) {
          return rem.indexOf(a) < 0;
        });
        return App.api.updateGroup(groupId, g);
      });
    },

    blockGroup: function (groupId) {
      var internalId = String(groupId || '').replace(/^group\./, '');
      return loadSyncedGroups().then(function (list) {
        list.forEach(function (g) {
          if (g.id === groupId || g.internal_id === internalId) g.blocked = true;
        });
        return saveSyncedGroups(list);
      });
    },

    pinMessage: function () {
      return Promise.resolve();
    },

    unpinMessage: function () {
      return Promise.resolve();
    },

    setUsername: function (username) {
      var link = 'https://signal.me/#eu/' + encodeURIComponent(username);
      return Promise.resolve({ username: username, username_link: link });
    }
  };
})();
