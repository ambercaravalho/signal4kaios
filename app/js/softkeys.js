(function () {
  'use strict';

  /* Presentational softkey bar (SoftLeft / Center / SoftRight labels).
     Key handling itself lives in the router, which dispatches to the
     active screen. */

  App.softkeys = {
    set: function (left, center, right) {
      document.getElementById('sk-left').textContent = left || '';
      document.getElementById('sk-center').textContent = center || '';
      document.getElementById('sk-right').textContent = right || '';
    }
  };
})();
