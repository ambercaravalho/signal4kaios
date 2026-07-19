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

  /* Timestamp for a message bubble. A bare time is meaningless once a message
     is more than a day old, so anything but today also carries the date:
       today      -> "14:32"
       yesterday  -> "Yesterday 14:32"
       this year  -> "10 Jul, 14:32"
       older      -> "10 Jul 2024, 14:32" */
  function fmtMsgTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var time = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return time;
    var yest = new Date(now.getTime());
    yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return 'Yesterday ' + time;
    var date = d.getDate() + ' ' + MONTHS[d.getMonth()];
    if (d.getFullYear() !== now.getFullYear()) date += ' ' + d.getFullYear();
    return date + ', ' + time;
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

  /* Open a URL in the phone browser via a KaiOS "view" web activity (WebActivity
     on 3.0/4.0, MozActivity on 2.5), falling back to window.open on desktop.
     App.platform.openActivity handles the version differences. */
  function openUrl(url) {
    if (!url) return;
    App.platform.openActivity('view', { type: 'url', url: url })['catch'](function () {
      if (App.toast) App.toast('Could not open link');
    });
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

  /* Match a single emoji (astral-plane glyph, flag pair, or one of the common
     BMP emoji symbols), including any VS16, skin-tone modifier, and ZWJ
     sequence that belongs with it. Gecko 48 has no /u flag or \p{}, so this
     works on UTF-16 surrogate units directly. */
  var EMOJI_RE = /(?:\uD83C[\uDDE6-\uDDFF]){2}|(?:[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u00A9\u00AE\u203C\u2049\u2122\u2139\u2194-\u21AA\u231A\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u27BF\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299])(?:\uFE0F)?(?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D(?:[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF])(?:\uFE0F)?(?:\uD83C[\uDFFB-\uDFFF])?)*/g;

  /* Append text to a container, wrapping emoji runs in <span class="emoji"> so
     they can be sized up to match the text. Plain text goes in as text nodes. */
  function emojify(container, text) {
    if (!text) return;
    EMOJI_RE.lastIndex = 0;
    var last = 0;
    var m;
    while ((m = EMOJI_RE.exec(text)) !== null) {
      if (!m[0]) { EMOJI_RE.lastIndex += 1; continue; } // guard zero-length
      if (m.index > last) {
        container.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      container.appendChild(el('span', 'emoji', m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) {
      container.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  /* Append text to a container, wrapping styled ranges in spans. Overlapping
     ranges are handled by splitting on every range boundary and applying all
     classes active over each segment. */
  function renderStyledBody(container, text, styles) {
    text = text || '';
    if (!styles || !styles.length) {
      emojify(container, text);
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
      emojify(container, text);
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
        var span = el('span', classes.join(' '));
        emojify(span, seg);
        container.appendChild(span);
      } else {
        emojify(container, seg);
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
    emojify: emojify,
    pad2: pad2,
    colorClass: colorClass,
    fmtTime: fmtTime,
    fmtTimeFull: fmtTimeFull,
    fmtMsgTime: fmtMsgTime,
    fmtDuration: fmtDuration,
    expireLabel: expireLabel,
    EXPIRE_OPTIONS: EXPIRE_OPTIONS,
    initials: initials,
    debounce: debounce,
    dbg: dbg,
    dbgLines: function () { return dbgBuf.slice(); }
  };
})();
