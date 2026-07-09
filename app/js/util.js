(function () {
  'use strict';

  var DBG_MAX = 150;
  var dbgBuf = [];

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function pad2(n) {
    return ('0' + n).slice(-2);
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
    if (d.getFullYear() === now.getFullYear()) {
      return d.getDate() + ' ' + MONTHS[d.getMonth()];
    }
    return pad2(d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(-2);
  }

  function fmtTimeFull(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function initials(name) {
    if (!name) return '?';
    var parts = String(name).trim().split(/\s+/);
    var out = parts[0].charAt(0);
    if (parts.length > 1) out += parts[parts.length - 1].charAt(0);
    return out.toUpperCase();
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () {
        t = null;
        fn.apply(self, args);
      }, ms);
    };
  }

  function dbg(msg, data) {
    var line = fmtTimeFull(Date.now()) + '  ' + msg;
    if (data !== undefined) {
      try {
        line += ' ' + JSON.stringify(data).slice(0, 300);
      } catch (e) { /* circular or unserializable, keep message only */ }
    }
    dbgBuf.push(line);
    if (dbgBuf.length > DBG_MAX) dbgBuf.shift();
  }

  /* Stable avatar color class (avatar-c0..avatar-c7) from a name hash. */
  function colorClass(name) {
    var h = 0;
    var s = String(name || '');
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return 'avatar-c' + (Math.abs(h) % 8);
  }

  /* Downscale an image Blob to maxDim px on its longest side and return a
     JPEG data URI (Promise). Keeps memory in check on 256MB devices. */
  function scaleImage(blob, maxDim) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.width, h = img.height;
          var scale = Math.min(1, maxDim / Math.max(w, h));
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read the image'));
      };
      img.src = url;
    });
  }

  App.util = {
    el: el,
    pad2: pad2,
    colorClass: colorClass,
    scaleImage: scaleImage,
    fmtTime: fmtTime,
    fmtTimeFull: fmtTimeFull,
    initials: initials,
    debounce: debounce,
    dbg: dbg,
    dbgLines: function () { return dbgBuf.slice(); }
  };
})();
