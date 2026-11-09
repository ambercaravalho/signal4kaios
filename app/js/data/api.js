(function () {
  'use strict';

  /* App-facing Signal API (`App.api`): sends, profile, attachments, and directory reads go through `App.signal` (on-device libsignal) and IndexedDB (`App.db`). Contact, group, pin, and username edits reach the Signal servers and the account's other devices. */

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

    /* Rename a contact (a Signal nickname, synced to your devices through Storage Service) and/or change the chat's disappearing-message timer (sent to the contact). */
    updateContact: function (recipient, name, expirationInSeconds) {
      var work = Promise.resolve();
      if (name != null) {
        work = work.then(function () {
          return loadSyncedContacts();
        }).then(function (list) {
          var found = false;
          list.forEach(function (c) {
            if (c.number === recipient || c.uuid === recipient) {
              c.name = name;
              found = true;
            }
          });
          if (!found) {
            list.push({
              uuid: recipient.indexOf('+') === 0 ? '' : recipient,
              number: recipient.indexOf('+') === 0 ? recipient : '',
              name: name || recipient,
              blocked: false,
              expireTimer: 0
            });
          }
          return saveSyncedContacts(list);
        }).then(function () {
          return App.signal.setContactNickname(recipient, name);
        });
      }
      if (expirationInSeconds != null) {
        work = work.then(function () {
          return App.signal.setDirectExpireTimer(recipient, expirationInSeconds);
        });
      }
      return work;
    },

    /* Block or unblock a person on all your devices. */
    blockContact: function (recipient) {
      return App.signal.setContactBlocked(recipient, true);
    },

    unblockContact: function (recipient) {
      return App.signal.setContactBlocked(recipient, false);
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
          admins: [],
          pending: []
        };
      });
    },

    /* Change group name, description, timer (expiration_time), permissions, or group link (group_link: disabled | enabled | enabled-with-approval, reset_link: true for a new link) on Signal's servers; members get the update. */
    updateGroup: function (groupId, body) {
      return App.signal.updateGroup(groupId, body || {});
    },

    quitGroup: function (groupId) {
      return App.signal.leaveGroup(groupId);
    },

    removeGroupMembers: function (groupId, members) {
      return App.signal.removeGroupMembers(groupId, [].concat(members));
    },

    /* Members are numbers, usernames, or ACIs; anyone who can't be added directly is invited. */
    addGroupMembers: function (groupId, members) {
      return App.signal.addGroupMembers(groupId, [].concat(members));
    },

    addGroupAdmins: function (groupId, admins) {
      return App.signal.setGroupAdmins(groupId, [].concat(admins), true);
    },

    removeGroupAdmins: function (groupId, admins) {
      return App.signal.setGroupAdmins(groupId, [].concat(admins), false);
    },

    /* Block and leave, on all your devices. */
    blockGroup: function (groupId) {
      return App.signal.setGroupBlocked(groupId, true);
    },

    unblockGroup: function (groupId) {
      return App.signal.setGroupBlocked(groupId, false);
    },

    /* Pin or unpin a message for everyone in a 1:1 or group chat. */
    pinMessage: function (recipient, targetAuthor, targetTimestamp) {
      return App.signal.sendPin(recipient, targetAuthor, targetTimestamp, true);
    },

    unpinMessage: function (recipient, targetAuthor, targetTimestamp) {
      return App.signal.sendPin(recipient, targetAuthor, targetTimestamp, false);
    },

    /* Reserve and confirm a username; resolves to { username, username_link }. */
    setUsername: function (username) {
      return App.signal.setUsername(username);
    },

    deleteUsername: function () {
      return App.signal.deleteUsername();
    }
  };
})();
