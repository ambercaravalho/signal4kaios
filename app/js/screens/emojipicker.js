(function () {
  'use strict';

  /* Emoji picker for the composer. Reuses the reaction picker's emoji list and
     calls onPick(emoji) with the chosen glyph, then pops.
     create(onPick) */

  App.screens.emojipicker = {
    create: function (onPick) {
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'Emoji'));
      el.appendChild(hdr);

      var body = App.util.el('div', 'list');
      el.appendChild(body);

      var grid = App.util.el('div', 'react-grid');
      var EMOJI = App.screens.reactions.EMOJI;
      EMOJI.forEach(function (e) {
        var cell = App.util.el('div', 'react-cell', e);
        cell.setAttribute('nav-selectable', 'true');
        cell.setAttribute('data-id', e);
        grid.appendChild(cell);
      });
      body.appendChild(grid);

      var nav = new App.Nav(el, { scrollEl: body, cols: 4 });

      return {
        el: el,
        enter: function () {
          App.softkeys.set('Back', 'Insert', '');
          nav.select(0);
        },
        onKey: function (evt) {
          if (nav.handleKey(evt)) return true;
          if (evt.key === 'Enter') {
            var sel = nav.selected();
            if (!sel) return true;
            var emoji = sel.getAttribute('data-id');
            App.router.pop();
            if (onPick) onPick(emoji);
            return true;
          }
          return false;
        }
      };
    }
  };
})();
