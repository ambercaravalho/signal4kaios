(function () {
  'use strict';

  /* In-app notice (KaiOS "In-App Notice" component): a top-of-screen banner
     with an app glyph plus primary/secondary text. Unlike App.toast (a plain
     transient line at the bottom) it is non-interactive but styled like a
     notification. Rendered in the #overlay layer so it floats above the
     current screen's header.

     App.notice.show(primary, secondary, { icon, ms }) */

  var node = null;
  var timer = null;

  function overlayEl() {
    return document.getElementById('overlay');
  }

  App.notice = {
    show: function (primary, secondary, opts) {
      opts = opts || {};
      var ov = overlayEl();
      if (!ov) return;
      App.notice.hide();

      node = App.util.el('div', 'notice');
      node.appendChild(App.util.el('div', 'notice-icon', opts.icon || 'S'));
      var main = App.util.el('div', 'notice-main');
      main.appendChild(App.util.el('div', 'notice-primary', primary || ''));
      if (secondary) {
        main.appendChild(App.util.el('div', 'notice-secondary', secondary));
      }
      node.appendChild(main);
      ov.appendChild(node);

      timer = setTimeout(App.notice.hide, opts.ms || 4000);
    },

    hide: function () {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (node && node.parentNode) node.parentNode.removeChild(node);
      node = null;
    }
  };
})();
