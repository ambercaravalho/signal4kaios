(function () {
  'use strict';

  /* Presentational softkey bar (SoftLeft / Center / SoftRight labels).
     Key handling itself lives in the router, which dispatches to the
     active screen.

     The center label is normally text, but may be an icon token for
     universally-recognized glyphs (per the KaiOS guide): pass an object
     { icon: 'play' } or { icon: 'pause' } instead of a string. */

  App.softkeys = {
    set: function (left, center, right) {
      document.getElementById('sk-left').textContent = left || '';
      var c = document.getElementById('sk-center');
      c.className = '';
      if (center && typeof center === 'object' && center.icon) {
        c.textContent = '';
        c.className = 'sk-icon sk-icon-' + center.icon;
      } else {
        c.textContent = center || '';
      }
      document.getElementById('sk-right').textContent = right || '';
    }
  };
})();
