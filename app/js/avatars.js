(function () {
  'use strict';

  /* Profile-photo loader for contacts and groups. Blobs are cached in the
     attachments store under 'avatar:<convId>' keys (excluded from the LRU
     prune), and object URLs are memoized per session. A miss (404 / no
     avatar) memoizes null so we don't hammer the server. */

  var memo = {}; // convId -> Promise<objectURL|null>

  function fetchBlob(conv) {
    if (conv.type === 'group') {
      if (!conv.sendId) return Promise.reject(new Error('no group id yet'));
      return App.api.groupAvatar(conv.sendId);
    }
    var contact = App.store.contactByKey(conv.id);
    if (contact && contact.hasAvatar === false) {
      return Promise.reject(new Error('contact has no avatar'));
    }
    var uuid = contact && contact.uuid;
    if (!uuid) return Promise.reject(new Error('no uuid known'));
    return App.api.contactAvatar(uuid);
  }

  function load(conv) {
    if (memo[conv.id]) return memo[conv.id];
    var key = 'avatar:' + conv.id;
    memo[conv.id] = App.db.getAttachment(key).then(function (row) {
      if (row && row.blob && row.blob.size) {
        return URL.createObjectURL(row.blob);
      }
      return fetchBlob(conv).then(function (blob) {
        if (!blob || !blob.size) throw new Error('empty avatar');
        App.db.putAttachment(key, blob, blob.type);
        return URL.createObjectURL(blob);
      });
    })['catch'](function () {
      return null;
    });
    return memo[conv.id];
  }

  /* Swap an initials circle for the real photo once it is available. */
  function apply(avatarEl, conv) {
    load(conv).then(function (url) {
      if (!url || !avatarEl.parentNode) return;
      avatarEl.textContent = '';
      var img = App.util.el('img', 'avatar-img');
      img.src = url;
      avatarEl.appendChild(img);
    });
  }

  App.avatars = { load: load, apply: apply };
})();
