(function () {
  'use strict';

  /* Generic vertical menu screen.
     create({ title, items: [{ label, hint, onSelect }] })
     After onSelect the menu pops, so you return to the previous screen — unless
     onSelect returns 'keep' or pushes another screen onto the stack (detected by
     a growth in router depth), in which case the menu stays underneath it. */

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
              var before = App.router.depth();
              var res = item.onSelect();
              // Keep the menu open if asked, or if the handler layered a new
              // screen on top (otherwise we'd immediately pop that new screen).
              if (res !== 'keep' && App.router.depth() <= before) {
                App.router.pop();
              }
            }
            return true;
          }
          return false;
        }
      };
    }
  };
})();
