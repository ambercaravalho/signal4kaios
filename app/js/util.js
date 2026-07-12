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

  /* Compact human duration ("45s", "5m", "1h", "2d", "1w") for countdowns. */
  function fmtDuration(secs) {
    secs = Math.max(0, Math.round(secs));
    if (secs < 60) return secs + 's';
    var mins = Math.round(secs / 60);
    if (mins < 60) return mins + 'm';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h';
    var days = Math.round(hrs / 24);
    if (days < 7) return days + 'd';
    return Math.round(days / 7) + 'w';
  }

  /* Standard Signal disappearing-message intervals: { secs, label }. */
  var EXPIRE_OPTIONS = [
    { secs: 0, label: 'Off' },
    { secs: 30, label: '30 seconds' },
    { secs: 300, label: '5 minutes' },
    { secs: 3600, label: '1 hour' },
    { secs: 28800, label: '8 hours' },
    { secs: 86400, label: '1 day' },
    { secs: 604800, label: '1 week' },
    { secs: 2419200, label: '4 weeks' }
  ];

  function expireLabel(secs) {
    for (var i = 0; i < EXPIRE_OPTIONS.length; i++) {
      if (EXPIRE_OPTIONS[i].secs === secs) return EXPIRE_OPTIONS[i].label;
    }
    return secs ? fmtDuration(secs) : 'Off';
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

  /* Non-navigable divider used to group list items under a heading. It has no
     nav-selectable attribute, so App.Nav skips over it. */
  function sectionHeader(text) {
    return el('div', 'section-title', text);
  }

  var URL_RE = /(https?:\/\/[^\s]+)/g;

  /* Pull http(s) URLs out of free text, dropping trailing sentence punctuation
     so "see http://x.com." doesn't capture the period. */
  function extractUrls(text) {
    var urls = [];
    if (!text) return urls;
    URL_RE.lastIndex = 0;
    var m;
    while ((m = URL_RE.exec(text)) !== null) {
      urls.push(m[0].replace(/[.,;:!?)]+$/, ''));
    }
    return urls;
  }

  /* Append text to a container, turning URLs into selectable link spans
     (mark them with nav-selectable; each carries the url on `.__url`). Callers
     handle Enter by checking `selectedEl.__url` and passing it to openUrl. */
  function linkify(container, text) {
    if (!text) return;
    URL_RE.lastIndex = 0;
    var last = 0;
    var m;
    while ((m = URL_RE.exec(text)) !== null) {
      if (m.index > last) {
        container.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      var url = m[0].replace(/[.,;:!?)]+$/, '');
      var span = el('span', 'link', url);
      span.setAttribute('nav-selectable', 'true');
      span.setAttribute('data-id', '__url');
      span.__url = url;
      container.appendChild(span);
      last = m.index + url.length;
    }
    if (last < text.length) {
      container.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  /* Open a URL in the phone browser via a KaiOS "view" web activity, falling
     back to window.open on desktop. */
  function openUrl(url) {
    if (!url) return;
    try {
      if (typeof MozActivity !== 'undefined') {
        var act = new MozActivity({ name: 'view', data: { type: 'url', url: url } });
        act.onerror = function () {
          if (App.toast) App.toast('Could not open link');
        };
      } else if (window.open) {
        window.open(url, '_blank');
      }
    } catch (e) {
      if (App.toast) App.toast('Could not open link');
    }
  }

  /* ---- Text styling (bold/italic/etc.) ----
     Signal carries formatting as body ranges { start, length, style } in UTF-16
     units — which line up exactly with JS string indices, so no conversion is
     needed. Supported styles match Signal's set (there is no underline). */
  var STYLE_CLASS = {
    BOLD: 'fmt-b',
    ITALIC: 'fmt-i',
    STRIKETHROUGH: 'fmt-st',
    MONOSPACE: 'fmt-mono',
    SPOILER: 'fmt-spoiler'
  };

  /* Markers understood by signal-cli-rest-api's "styled" text mode. Longer
     openers are listed first so ** wins over *. */
  var STYLE_MARKERS = [
    { o: '||', c: '||', s: 'SPOILER' },
    { o: '**', c: '**', s: 'BOLD' },
    { o: '*', c: '*', s: 'ITALIC' },
    { o: '~', c: '~', s: 'STRIKETHROUGH' },
    { o: '`', c: '`', s: 'MONOSPACE' }
  ];

  function findClose(text, close, from) {
    var clen = close.length;
    var i = from;
    while (i <= text.length - clen) {
      if (text.charAt(i) === '\\') { i += 2; continue; }
      if (text.substr(i, clen) === close) return i;
      i += 1;
    }
    return -1;
  }

  function stripEscapes(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      if (s.charAt(i) === '\\' && i + 1 < s.length) {
        out += s.charAt(i + 1);
        i += 1;
      } else {
        out += s.charAt(i);
      }
    }
    return out;
  }

  /* Parse markdown-style markers into a plain body plus a list of style ranges,
     mirroring how the server interprets "styled" mode. Used for the local echo
     of messages we send so our own bubbles show the same formatting the
     recipient gets. Unmatched markers are left as literal text. */
  function parseStyledMarkdown(text) {
    var styles = [];
    if (!text) return { body: '', styles: styles };
    var out = '';
    var i = 0;
    var n = text.length;
    while (i < n) {
      var ch = text.charAt(i);
      if (ch === '\\' && i + 1 < n) { out += text.charAt(i + 1); i += 2; continue; }
      var matched = false;
      for (var k = 0; k < STYLE_MARKERS.length; k++) {
        var mk = STYLE_MARKERS[k];
        if (text.substr(i, mk.o.length) !== mk.o) continue;
        var innerStart = i + mk.o.length;
        var closeIdx = findClose(text, mk.c, innerStart);
        if (closeIdx < 0 || closeIdx === innerStart) continue;
        var inner = stripEscapes(text.slice(innerStart, closeIdx));
        styles.push({ start: out.length, length: inner.length, style: mk.s });
        out += inner;
        i = closeIdx + mk.c.length;
        matched = true;
        break;
      }
      if (!matched) { out += ch; i += 1; }
    }
    return { body: out, styles: styles };
  }

  /* Append text to a container, wrapping styled ranges in spans. Overlapping
     ranges are handled by splitting on every range boundary and applying all
     classes active over each segment. */
  function renderStyledBody(container, text, styles) {
    text = text || '';
    if (!styles || !styles.length) {
      container.appendChild(document.createTextNode(text));
      return;
    }
    var valid = [];
    var pts = { 0: 1 };
    pts[text.length] = 1;
    for (var i = 0; i < styles.length; i++) {
      var a = Math.max(0, styles[i].start | 0);
      var b = Math.min(text.length, a + (styles[i].length | 0));
      if (b > a && STYLE_CLASS[styles[i].style]) {
        valid.push({ a: a, b: b, cls: STYLE_CLASS[styles[i].style] });
        pts[a] = 1;
        pts[b] = 1;
      }
    }
    if (!valid.length) {
      container.appendChild(document.createTextNode(text));
      return;
    }
    var bounds = Object.keys(pts).map(Number).sort(function (x, y) { return x - y; });
    for (var s = 0; s < bounds.length - 1; s++) {
      var segA = bounds[s];
      var segB = bounds[s + 1];
      if (segB <= segA) continue;
      var seg = text.slice(segA, segB);
      var classes = [];
      valid.forEach(function (v) {
        if (v.a <= segA && v.b >= segB && classes.indexOf(v.cls) === -1) {
          classes.push(v.cls);
        }
      });
      if (classes.length) {
        container.appendChild(el('span', classes.join(' '), seg));
      } else {
        container.appendChild(document.createTextNode(seg));
      }
    }
  }

  App.util = {
    el: el,
    sectionHeader: sectionHeader,
    extractUrls: extractUrls,
    linkify: linkify,
    openUrl: openUrl,
    parseStyledMarkdown: parseStyledMarkdown,
    renderStyledBody: renderStyledBody,
    pad2: pad2,
    colorClass: colorClass,
    scaleImage: scaleImage,
    fmtTime: fmtTime,
    fmtTimeFull: fmtTimeFull,
    fmtDuration: fmtDuration,
    expireLabel: expireLabel,
    EXPIRE_OPTIONS: EXPIRE_OPTIONS,
    initials: initials,
    debounce: debounce,
    dbg: dbg,
    dbgLines: function () { return dbgBuf.slice(); }
  };
})();
