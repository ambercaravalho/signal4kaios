(function () {
  'use strict';

  /* Safety numbers: lists known identities from GET /v1/identities/{number}
     and lets you trust one via PUT /v1/identities/{number}/trust/{target}.
     create({ number? }) — when a number is given, only that identity shows. */

  App.screens.safety = {
    create: function (opts) {
      opts = opts || {};
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'Safety numbers'));
      el.appendChild(hdr);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      var nav = new App.Nav(el, { scrollEl: list });
      var rows = [];

      function labelFor(entry) {
        var key = entry.number || entry.uuid;
        var name = App.store.displayName(key);
        return name && name !== key ? name : (key || '?');
      }

      function render() {
        list.textContent = '';
        if (!rows.length) {
          list.appendChild(App.util.el('div', 'empty', 'No identities found.'));
          nav.refresh();
          return;
        }
        rows.forEach(function (entry, i) {
          var row = App.util.el('div', 'conv-row');
          row.setAttribute('nav-selectable', 'true');
          row.setAttribute('data-id', String(i));
          var main = App.util.el('div', 'conv-main');
          var top = App.util.el('div', 'conv-top');
          top.appendChild(App.util.el('span', 'conv-name', labelFor(entry)));
          if (entry.status) {
            top.appendChild(App.util.el('span', 'conv-time', entry.status));
          }
          main.appendChild(top);
          var sn = entry.safety_number || entry.fingerprint || '';
          if (sn) {
            var bottom = App.util.el('div', 'conv-bottom');
            bottom.appendChild(App.util.el('span', 'conv-preview',
              sn.slice(0, 40) + (sn.length > 40 ? '…' : '')));
            main.appendChild(bottom);
          }
          row.appendChild(main);
          list.appendChild(row);
        });
        nav.refresh();
      }

      function load() {
        list.textContent = '';
        list.appendChild(App.util.el('div', 'empty', 'Loading…'));
        App.api.identities().then(function (res) {
          var all = res || [];
          rows = opts.number
            ? all.filter(function (e) { return e.number === opts.number; })
            : all;
          render();
          if (rows.length) nav.selectById('0');
        })['catch'](function (err) {
          list.textContent = '';
          list.appendChild(App.util.el('div', 'empty', err.message || 'Failed to load'));
        });
      }

      function openActions(entry) {
        var target = entry.number || entry.uuid;
        App.router.push(App.screens.menu.create({
          title: labelFor(entry),
          items: [{
            label: 'Mark verified',
            hint: 'Trust this safety number',
            onSelect: function () {
              App.api.trustIdentity(target, { trust_all_known_keys: true })
                .then(function () {
                  App.toast('Marked verified');
                  load();
                })['catch'](function (err) {
                  App.toast('Trust failed: ' + err.message);
                });
            }
          }]
        }));
      }

      return {
        el: el,
        enter: function () {
          App.softkeys.set('', 'Select', '');
          load();
        },
        resume: function () {
          App.softkeys.set('', 'Select', '');
        },
        onKey: function (evt) {
          if (nav.handleKey(evt)) return true;
          if (evt.key === 'Enter') {
            var sel = nav.selected();
            if (!sel) return true;
            var entry = rows[parseInt(sel.getAttribute('data-id'), 10)];
            if (entry) openActions(entry);
            return true;
          }
          return false;
        }
      };
    }
  };
})();
