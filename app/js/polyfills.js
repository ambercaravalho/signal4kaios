/* Gecko 48 compatibility shims. Keep tiny; the packaging grep gate catches
   post-48 syntax, these cover the few missing runtime methods we rely on. */
(function () {
  'use strict';

  if (window.NodeList && !NodeList.prototype.forEach) {
    NodeList.prototype.forEach = Array.prototype.forEach;
  }

  // Global app namespace; every module attaches to this.
  window.App = window.App || { screens: {} };
})();
