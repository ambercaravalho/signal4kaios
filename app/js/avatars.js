(function () {
  'use strict';

  /* Profile-photo loader for contacts and groups. Blobs are cached in the
     attachments store under 'avatar:<convId>' keys (excluded from the LRU
     prune), and object URLs are memoized per session. A miss (404 / no
     avatar) memoizes null so we don't hammer the server. */

  var memo = {}; // convId -> Promise<objectURL|null>

  /* Reject anything that isn't a usable image so a proxy/error body
     (e.g. an HTML 404 page returned with a non-zero length) never gets
     cached and rendered as a broken <img>. */
  function ensureImage(blob) {
    if (!blob || !blob.size) throw new Error('empty avatar');
    if ((blob.type || '').indexOf('image/') !== 0) {
      throw new Error('not an image: ' + (blob.type || 'unknown'));
    }
    return blob;
  }

  function fetchBlob(conv) {
    if (conv.type === 'group') {
      if (!conv.sendId) return Promise.reject(new Error('no group id yet'));
      return App.api.groupAvatar(conv.sendId).then(ensureImage);
    }
    var contact = App.store.contactByKey(conv.id);
    if (contact && contact.hasAvatar === false) {
      return Promise.reject(new Error('contact has no avatar'));
    }
    var uuid = contact && contact.uuid;
    if (!uuid) return Promise.reject(new Error('no uuid known'));
    return App.api.contactAvatar(uuid).then(ensureImage);
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

  /* Swap an initials circle for the real photo once it is available.
     The initials stay put until the image actually decodes; a decode
     failure leaves them intact instead of showing a broken <img>. */
  function apply(avatarEl, conv) {
    load(conv).then(function (url) {
      if (!url || !avatarEl.parentNode) return;
      var img = App.util.el('img', 'avatar-img');
      img.onload = function () {
        if (!avatarEl.parentNode) return;
        avatarEl.textContent = '';
        avatarEl.appendChild(img);
      };
      img.onerror = function () {
        App.util.dbg('avatar decode failed for ' + conv.id);
      };
      img.src = url;
    });
  }

  /* Build the avatar element for a conversation row/header. The self chat
     ("Note to Self") gets a notebook glyph instead of initials or a photo,
     matching other Signal clients; everyone else gets initials that upgrade to
     the real profile photo when it loads. */
  function elFor(conv) {
    if (App.store.isSelfConv(conv)) {
      return App.util.el('div', 'avatar note-self', '📔');
    }
    var avatarEl = App.util.el('div',
      'avatar ' + App.util.colorClass(conv.name || conv.id),
      App.util.initials(conv.name));
    apply(avatarEl, conv);
    return avatarEl;
  }

  App.avatars = { load: load, apply: apply, el: elFor };
})();
