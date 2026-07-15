(function () {
  'use strict';

  /* Emoji reaction picker: a fuller grid of common, widely-rendered emoji
     (KaiOS 2.5 / Gecko 48 has limited coverage, so this sticks to older,
     broadly-supported glyphs), plus a "remove my reaction" row when
     applicable. The list is shared with the composer emoji picker. */

  var EMOJI = [
    '❤️', '👍', '👎', '😂',
    '😮', '😢', '😡', '😀',
    '😁', '😅', '😆', '😉',
    '😊', '😍', '😘', '😜',
    '😳', '😴', '😭', '😱',
    '👏', '🙏', '🔥', '💯'
  ];

  App.screens.reactions = {
    create: function (rec) {
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'React'));
      el.appendChild(hdr);

      var body = App.util.el('div', 'list');
      el.appendChild(body);

      var grid = App.util.el('div', 'react-grid');
      EMOJI.forEach(function (e) {
        var cell = App.util.el('div', 'react-cell', e);
        cell.setAttribute('nav-selectable', 'true');
        cell.setAttribute('data-id', e);
        grid.appendChild(cell);
      });
      body.appendChild(grid);

      var mine = (rec.reactions || {})[App.store.selfNumber()];
      if (mine) {
        var rm = App.util.el('div', 'react-remove', 'Remove my reaction (' + mine + ')');
        rm.setAttribute('nav-selectable', 'true');
        rm.setAttribute('data-id', '__remove');
        body.appendChild(rm);
      }

      var nav = new App.Nav(el, { scrollEl: body, cols: 4 });

      function pick(emojiOrNull) {
        App.store.reactTo(rec, emojiOrNull)['catch'](function (err) {
          App.toast('Reaction failed: ' + err.message);
        });
        App.router.pop();
      }

      return {
        el: el,
        enter: function () {
          App.softkeys.set('Back', 'React', '');
          nav.select(0);
        },
        onKey: function (evt) {
          if (nav.handleKey(evt)) return true;
          if (evt.key === 'Enter') {
            var sel = nav.selected();
            if (!sel) return true;
            var id = sel.getAttribute('data-id');
            pick(id === '__remove' ? null : id);
            return true;
          }
          return false;
        }
      };
    },
    EMOJI: EMOJI
  };
})();
