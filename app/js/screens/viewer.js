(function () {
  'use strict';

  /* Full-screen attachment viewer. Downloads via systemXHR, caches the blob
     in IndexedDB (LRU, ~40 entries) so re-viewing works offline. */

  var CACHE_KEEP = 40;

  App.screens.viewer = {
    create: function (att) {
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', att.filename || 'Attachment'));
      el.appendChild(hdr);

      var box = App.util.el('div', 'viewer');
      var status = App.util.el('div', 'viewer-status', 'Loading…');
      box.appendChild(status);
      el.appendChild(box);

      var objectUrl = null;
      var isImage = (att.contentType || '').indexOf('image/') === 0;

      function show(blob) {
        status.classList.add('hidden');
        if (!isImage && (blob.type || '').indexOf('image/') !== 0) {
          status.classList.remove('hidden');
          status.textContent = 'Downloaded (' + Math.round(blob.size / 1024) +
            ' KB), but this file type cannot be shown here: ' +
            (att.contentType || 'unknown');
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        var img = App.util.el('img');
        img.src = objectUrl;
        box.appendChild(img);
      }

      function fail(err) {
        status.textContent = 'Could not load attachment: ' + err.message;
        status.classList.add('bad');
      }

      function load() {
        if (!att.id) {
          fail(new Error('no attachment id (sent from this device?)'));
          return;
        }
        App.db.getAttachment(att.id).then(function (row) {
          if (row && row.blob) {
            show(row.blob);
            return null;
          }
          return App.api.attachment(att.id).then(function (blob) {
            show(blob);
            App.db.putAttachment(att.id, blob, att.contentType).then(function () {
              return App.db.pruneAttachments(CACHE_KEEP);
            });
          });
        })['catch'](fail);
      }

      return {
        el: el,
        enter: function () {
          App.softkeys.set('', '', 'Back');
          load();
        },
        destroy: function () {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
        },
        onKey: function (evt) {
          if (evt.key === 'SoftRight') {
            App.router.pop();
            return true;
          }
          return false;
        }
      };
    }
  };
})();
