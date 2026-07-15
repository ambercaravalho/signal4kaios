(function () {
  'use strict';

  /* Presentational softkey bar (SoftLeft / Center / SoftRight labels).
     Key handling itself lives in the router, which dispatches to the
     active screen.

     Any of the three labels is normally text, but may be an icon token for
     universally-recognized glyphs (per the KaiOS guide): pass an object
     { icon: 'play' | 'pause' } instead of a string. */

  function applyKey(id, val) {
    var node = document.getElementById(id);
    if (val && typeof val === 'object' && val.icon) {
      node.textContent = '';
      node.className = 'sk-icon sk-icon-' + val.icon;
    } else {
      node.className = '';
      node.textContent = val || '';
    }
  }

  App.softkeys = {
    set: function (left, center, right) {
      applyKey('sk-left', left);
      applyKey('sk-center', center);
      applyKey('sk-right', right);
    }
  };
})();
