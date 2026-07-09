(function () {
  'use strict';

  /* Generic vertical menu screen.
     create({ title, items: [{ label, hint, onSelect }] })
     onSelect returning 'keep' leaves the menu open; anything else pops. */

  App.screens.menu = {
    create: function (opts) {
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', opts.title || ''));
      el.appendChild(hdr);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      opts.items.forEach(function (item, i) {
        var row = App.util.el('div', 'menu-item', item.label);
        row.setAttribute('nav-selectable', 'true');
        row.setAttribute('data-id', String(i));
        if (item.hint) row.appendChild(App.util.el('span', 'hint', item.hint));
        list.appendChild(row);
      });

      var nav = new App.Nav(el, { scrollEl: list });

      return {
        el: el,
        enter: function () {
          App.softkeys.set('', 'Select', '');
          nav.select(0);
        },
        resume: function () {
          App.softkeys.set('', 'Select', '');
        },
        onKey: function (evt) {
          if (nav.handleKey(evt)) return true;
          if (evt.key === 'Enter') {
            var sel = nav.selected();
            if (!sel) return true;
            var item = opts.items[parseInt(sel.getAttribute('data-id'), 10)];
            if (item && item.onSelect) {
              if (item.onSelect() !== 'keep') App.router.pop();
            }
            return true;
          }
          return false;
        }
      };
    }
  };
})();
