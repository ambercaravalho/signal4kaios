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

    profile: function () {
      return App.http.get('/v1/profile/' + num());
    },

    /* Binary download of a received attachment; resolves to a Blob. */
    attachment: function (id) {
      return App.http.get('/v1/attachments/' + encodeURIComponent(id),
        { binary: true, timeout: 60000 });
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
    }
  };
})();
