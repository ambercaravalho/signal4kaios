(function () {
  'use strict';

  /* Full-message reader: shows a long message body in a scrollable pane so
     it can be read end to end. Up/Down scroll the text; Back pops. */

  var SCROLL_STEP = 60; // px per Up/Down press

  App.screens.msgview = {
    create: function (rec) {
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      var who = rec.incoming
        ? (App.store.displayName(rec.author) || 'Message')
        : 'You';
      hdr.appendChild(App.util.el('span', 'hdr-title', who));
      hdr.appendChild(App.util.el('span', 'hdr-sub', App.util.fmtTime(rec.timestamp)));
      el.appendChild(hdr);

      var pane = App.util.el('div', 'msgview-pane');
      var bodyEl = App.util.el('div', 'msgview-body');
      App.util.renderStyledBody(bodyEl, rec.body || '', rec.styles);
      pane.appendChild(bodyEl);
      el.appendChild(pane);

      function scrollBy(dy) {
        pane.scrollTop = Math.max(0,
          Math.min(pane.scrollHeight, pane.scrollTop + dy));
      }

      return {
        el: el,
        enter: function () {
          App.softkeys.set({ icon: 'back' }, '', '');
          pane.scrollTop = 0;
        },
        resume: function () {
          App.softkeys.set({ icon: 'back' }, '', '');
        },
        onKey: function (evt) {
          if (evt.key === 'ArrowDown') {
            scrollBy(SCROLL_STEP);
            return true;
          }
          if (evt.key === 'ArrowUp') {
            scrollBy(-SCROLL_STEP);
            return true;
          }
          return false;
        }
      };
    }
  };
})();
