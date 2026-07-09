(function () {
  'use strict';

  /* Local message search: scans the IndexedDB message store (there is no
     server-side content search in signal-cli-rest-api). */

  App.screens.search = {
    create: function () {
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'Search'));
      el.appendChild(hdr);

      var field = App.util.el('div', 'field');
      var input = App.util.el('input');
      input.type = 'text';
      input.placeholder = 'Search messages…';
      input.setAttribute('nav-selectable', 'true');
      input.setAttribute('data-id', '__query');
      field.appendChild(input);
      el.appendChild(field);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      var results = [];
      var nav = new App.Nav(el, { scrollEl: list });

      function updateSoftkeys() {
        var sel = nav.selected();
        App.softkeys.set('', sel === input ? 'Search' : 'Open', '');
      }

      function renderResults() {
        list.textContent = '';
        if (!results.length) {
          list.appendChild(App.util.el('div', 'empty', 'No matches.'));
          nav.refresh();
          return;
        }
        results.forEach(function (rec, i) {
          var conv = App.store.conversation(rec.convId);
          var row = App.util.el('div', 'conv-row');
          row.setAttribute('nav-selectable', 'true');
          row.setAttribute('data-id', String(i));

          var main = App.util.el('div', 'conv-main');
          var top = App.util.el('div', 'conv-top');
          top.appendChild(App.util.el('span', 'conv-name',
            conv ? conv.name : rec.convId));
          top.appendChild(App.util.el('span', 'conv-time',
            App.util.fmtTime(rec.timestamp)));
          main.appendChild(top);

          var bottom = App.util.el('div', 'conv-bottom');
          var who = rec.incoming
            ? (rec.authorName || App.store.displayName(rec.author))
            : 'You';
          bottom.appendChild(App.util.el('span', 'conv-preview',
            who + ': ' + rec.body.slice(0, 60)));
          main.appendChild(bottom);
          row.appendChild(main);
          list.appendChild(row);
        });
        nav.refresh();
      }

      function run() {
        var q = input.value.replace(/^\s+|\s+$/g, '');
        if (q.length < 2) {
          App.toast('Type at least 2 characters');
          return;
        }
        list.textContent = '';
        list.appendChild(App.util.el('div', 'empty', 'Searching…'));
        App.db.searchMessages(q, 50).then(function (rows) {
          results = rows;
          renderResults();
          if (rows.length) nav.selectById('0');
          updateSoftkeys();
        });
      }

      return {
        el: el,
        enter: function () {
          nav.select(0);
          updateSoftkeys();
        },
        resume: function () {
          nav.refresh();
          updateSoftkeys();
        },
        onKey: function (evt) {
          var inInput = document.activeElement === input;
          if (inInput && (evt.key === 'ArrowLeft' || evt.key === 'ArrowRight')) {
            return false; // move the text cursor
          }
          if (nav.handleKey(evt)) {
            updateSoftkeys();
            return true;
          }
          if (evt.key === 'Enter') {
            var sel = nav.selected();
            if (sel === input) {
              run();
              return true;
            }
            if (sel) {
              var rec = results[parseInt(sel.getAttribute('data-id'), 10)];
              if (rec && App.store.conversation(rec.convId)) {
                App.router.push(App.screens.chat.create(rec.convId));
              }
              return true;
            }
          }
          return false;
        }
      };
    }
  };
})();
