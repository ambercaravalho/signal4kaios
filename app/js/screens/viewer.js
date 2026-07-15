(function () {
  'use strict';

  /* Full-screen attachment viewer. Downloads via systemXHR, caches the blob
     in IndexedDB (LRU, ~40 entries). Images display inline, audio and video
     play in-app with the center key, and anything downloaded can be saved to
     the phone via DeviceStorage (SoftLeft). */

  var CACHE_KEEP = 150; // shared attachment LRU; matches chat thumbnail cache

  function storageFor(type) {
    if (type.indexOf('image/') === 0) return 'pictures';
    if (type.indexOf('audio/') === 0) return 'music';
    if (type.indexOf('video/') === 0) return 'videos';
    return 'sdcard';
  }

  function extFor(type) {
    var map = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
      'audio/aac': '.aac', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg',
      'video/mp4': '.mp4'
    };
    return map[type] || '';
  }

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
      var loadedBlob = null;
      var media = null; // the <audio> or <video> element, when playable

      function type() {
        return (loadedBlob && loadedBlob.type) || att.contentType || '';
      }

      function setStatus(text, cls) {
        status.classList.remove('hidden');
        status.textContent = text;
        status.className = 'viewer-status' + (cls ? ' ' + cls : '');
      }

      function updateSoftkeys() {
        var center = '';
        if (media) center = { icon: media.paused ? 'play' : 'pause' };
        App.softkeys.set({ icon: 'back' }, center, loadedBlob ? 'Save' : '');
      }

      function show(blob) {
        loadedBlob = blob;
        var t = type();
        objectUrl = URL.createObjectURL(blob);
        if (t.indexOf('image/') === 0) {
          status.classList.add('hidden');
          var img = App.util.el('img');
          img.src = objectUrl;
          box.appendChild(img);
        } else if (t.indexOf('audio/') === 0) {
          setStatus('♪ ' + (att.filename || 'Voice message') +
            '\nPress the center key to play.');
          media = new Audio(objectUrl);
          media.onended = function () {
            setStatus('♪ Finished. Center key replays.');
            updateSoftkeys();
          };
        } else if (t.indexOf('video/') === 0) {
          status.classList.add('hidden');
          var video = document.createElement('video');
          video.setAttribute('playsinline', 'true');
          video.src = objectUrl;
          box.appendChild(video);
          media = video;
          media.onended = function () { updateSoftkeys(); };
        } else {
          setStatus('Downloaded ' + Math.round(blob.size / 1024) + ' KB (' +
            (t || 'unknown type') + ').\nPress Save to store it on the phone.');
        }
        updateSoftkeys();
      }

      function fail(err) {
        setStatus('Could not load attachment: ' + err.message, 'bad');
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

      function save() {
        if (!loadedBlob) return;
        if (!navigator.getDeviceStorage) {
          App.toast('Saving only works on the phone');
          return;
        }
        var storage = navigator.getDeviceStorage(storageFor(type()));
        if (!storage) {
          App.toast('No storage available');
          return;
        }
        var name = att.filename ||
          ('signal_' + Date.now() + extFor(type()));
        var req = storage.addNamed(loadedBlob, name);
        req.onsuccess = function () { App.toast('Saved as ' + this.result); };
        req.onerror = function () {
          App.toast('Save failed: ' + (this.error && this.error.name === 'NoModificationAllowedError'
            ? 'file already exists' : (this.error ? this.error.name : 'unknown')));
        };
      }

      function togglePlay() {
        if (!media) return;
        var isAudio = type().indexOf('audio/') === 0;
        if (media.paused) {
          media.play();
          if (isAudio) setStatus('♪ Playing… center key pauses.');
        } else {
          media.pause();
          if (isAudio) setStatus('♪ Paused. Center key resumes.');
        }
        updateSoftkeys();
      }

      return {
        el: el,
        enter: function () {
          updateSoftkeys();
          load();
        },
        destroy: function () {
          if (media) {
            media.pause();
            media = null;
          }
          if (objectUrl) URL.revokeObjectURL(objectUrl);
        },
        onKey: function (evt) {
          switch (evt.key) {
            case 'SoftRight':
              save();
              return true;
            case 'Enter':
              togglePlay();
              return true;
            default:
              return false;
          }
        }
      };
    }
  };
})();
