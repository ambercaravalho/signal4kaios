(function () {
  'use strict';

  /* Thin wrappers over signal-cli-rest-api endpoints.
     Request shapes verified against bbernhard/signal-cli-rest-api api.go. */

  function num() {
    return encodeURIComponent(App.config.number());
  }

  App.api = {
    about: function () {
      return App.http.get('/v1/about', { timeout: 8000 });
    },

    contacts: function () {
      return App.http.get('/v1/contacts/' + num());
    },

    groups: function () {
      return App.http.get('/v1/groups/' + num());
    },

    /* Binary download of a received attachment; resolves to a Blob. */
    attachment: function (id) {
      return App.http.get('/v1/attachments/' + encodeURIComponent(id),
        { binary: true, timeout: 60000 });
    },

    contactAvatar: function (uuid) {
      return App.http.get('/v1/contacts/' + num() + '/' +
        encodeURIComponent(uuid) + '/avatar', { binary: true, timeout: 20000 });
    },

    /* groupId is the send id ("group.…"). */
    groupAvatar: function (groupId) {
      return App.http.get('/v1/groups/' + num() + '/' +
        encodeURIComponent(groupId) + '/avatar', { binary: true, timeout: 20000 });
    },

    /* payload: { recipients: [..], message, quote_timestamp?, quote_author?,
       quote_message? } — response: { timestamp } */
    send: function (payload) {
      var body = Object.assign({ number: App.config.number() }, payload);
      return App.http.post('/v2/send', body, { timeout: 30000 });
    },

    react: function (recipient, targetAuthor, targetTimestamp, emoji) {
      return App.http.post('/v1/reactions/' + num(), {
        recipient: recipient,
        reaction: emoji,
        target_author: targetAuthor,
        timestamp: targetTimestamp
      });
    },

    unreact: function (recipient, targetAuthor, targetTimestamp, emoji) {
      return App.http.del('/v1/reactions/' + num(), {
        recipient: recipient,
        reaction: emoji,
        target_author: targetAuthor,
        timestamp: targetTimestamp
      });
    },

    remoteDelete: function (recipient, timestamp) {
      return App.http.del('/v1/remote-delete/' + num(), {
        recipient: recipient,
        timestamp: timestamp
      });
    },

    typingStart: function (recipient) {
      return App.http.put('/v1/typing-indicator/' + num(), { recipient: recipient });
    },

    typingStop: function (recipient) {
      return App.http.del('/v1/typing-indicator/' + num(), { recipient: recipient });
    },

    readReceipt: function (recipient, timestamp) {
      return App.http.post('/v1/receipts/' + num(), {
        recipient: recipient,
        receipt_type: 'read',
        timestamp: timestamp
      });
    },

    /* Check whether one or more numbers are registered with Signal.
       Resolves to an array of { number, registered }. */
    searchNumbers: function (numbers) {
      var list = [].concat(numbers);
      var query = [];
      for (var i = 0; i < list.length; i++) {
        query.push('numbers=' + encodeURIComponent(list[i]));
      }
      return App.http.get('/v1/search/' + num() + '?' + query.join('&'),
        { timeout: 20000 });
    },

    /* Known identities (safety numbers / fingerprints) for this account. */
    identities: function () {
      return App.http.get('/v1/identities/' + num());
    },

    /* Trust a contact's identity. opts: { trust_all_known_keys?,
       verified_safety_number? } */
    trustIdentity: function (target, opts) {
      return App.http.put('/v1/identities/' + num() + '/trust/' +
        encodeURIComponent(target), opts || { trust_all_known_keys: true });
    },

    /* Update this account's profile. body: { name?, base64_avatar?, about? } */
    updateProfile: function (body) {
      return App.http.put('/v1/profiles/' + num(), body || {});
    },

    /* Rename a saved contact. */
    updateContact: function (recipient, name) {
      return App.http.put('/v1/contacts/' + num(), {
        recipient: recipient,
        name: name
      });
    },

    /* Push local contact changes to linked devices. */
    syncContacts: function () {
      return App.http.post('/v1/contacts/' + num() + '/sync', {});
    },

    /* Full detail for one group (members, description, admins). groupId is the
       send id ("group.…"). */
    groupDetail: function (groupId) {
      return App.http.get('/v1/groups/' + num() + '/' +
        encodeURIComponent(groupId));
    },

    /* Update group metadata. body: { name?, description?, base64_avatar? } */
    updateGroup: function (groupId, body) {
      return App.http.put('/v1/groups/' + num() + '/' +
        encodeURIComponent(groupId), body || {});
    },

    /* Leave a group. */
    quitGroup: function (groupId) {
      return App.http.post('/v1/groups/' + num() + '/' +
        encodeURIComponent(groupId) + '/quit', {});
    },

    /* Remove members from a group. members: array of numbers/uuids. */
    removeGroupMembers: function (groupId, members) {
      return App.http.del('/v1/groups/' + num() + '/' +
        encodeURIComponent(groupId) + '/members', { members: [].concat(members) });
    }
  };
})();
