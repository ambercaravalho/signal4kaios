(function () {
  'use strict';

  /* Main settings menu. The signal-cli-rest-api connection fields live in their
     own screen (App.screens.serversettings); everything here is a menu action or
     a toggle. */

  App.screens.settings = {
    create: function () {
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'Settings'));
      el.appendChild(hdr);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      function action(label, hint) {
        var row = App.util.el('div', 'menu-item', label);
        row.setAttribute('nav-selectable', 'true');
        row.setAttribute('data-id', label);
        if (hint) row.appendChild(App.util.el('span', 'hint', hint));
        list.appendChild(row);
        return row;
      }

      /* A menu-item whose hint reflects a boolean; toggled in onAction. */
      function toggleAction(label, hintFn) {
        var row = action(label, hintFn());
        row.__hintFn = hintFn;
        return row;
      }

      function refreshToggle(row) {
        if (!row || !row.__hintFn) return;
        var hint = row.querySelector('.hint');
        if (hint) hint.textContent = row.__hintFn();
      }

      list.appendChild(App.util.sectionHeader('Server'));
      action('Server & connection', 'URL, number, proxy auth');

      list.appendChild(App.util.sectionHeader('Privacy'));
      var receiptsRow = toggleAction('Read receipts', function () {
        return App.config.sendReadReceipts() ? 'On' : 'Off';
      });

      list.appendChild(App.util.sectionHeader('Composer'));
      var styledRow = toggleAction('Text formatting', function () {
        return App.config.styledText() ? 'On' : 'Off';
      });

      list.appendChild(App.util.sectionHeader('Profile'));
      action('Edit profile', 'Set your Signal name');

      list.appendChild(App.util.sectionHeader('Accounts'));
      action('Switch account', 'Change or add a number');

      list.appendChild(App.util.sectionHeader('Data'));
      action('Refresh contacts & groups');
      action('Debug log');
      action('Clear local data', 'Deletes cached messages on this phone');

      var status = App.util.el('div', 'status-line', '');
      list.appendChild(status);

      var nav = new App.Nav(el, { scrollEl: list });

      function setStatus(text, cls) {
        status.textContent = text;
        status.className = 'status-line' + (cls ? ' ' + cls : '');
      }

      function accountSwitcher() {
        var accounts = App.config.accounts();
        var active = App.config.number();
        var items = accounts.map(function (a) {
          return {
            label: a.number + (a.number === active ? ' (current)' : ''),
            hint: a.serverUrl,
            onSelect: function () {
              if (a.number === active) return;
              App.config.switchAccount(a.number);
              location.reload();
            }
          };
        });
        items.push({
          label: 'Add account',
          hint: 'Set up another number',
          onSelect: function () {
            App.router.push(App.screens.serversettings.create({ addAccount: true }));
            return 'keep';
          }
        });
        App.router.push(App.screens.menu.create({ title: 'Accounts', items: items }));
      }

      function onAction(id) {
        switch (id) {
          case 'Server & connection':
            return App.router.push(App.screens.serversettings.create());
          case 'Read receipts':
            App.config.set({ sendReadReceipts: !App.config.sendReadReceipts() });
            refreshToggle(receiptsRow);
            return;
          case 'Text formatting':
            App.config.set({ styledText: !App.config.styledText() });
            refreshToggle(styledRow);
            return;
          case 'Edit profile':
            return App.router.push(App.screens.profile.create());
          case 'Switch account':
            return accountSwitcher();
          case 'Refresh contacts & groups':
            setStatus('Refreshing…');
            App.store.refreshDirectory().then(function () {
              setStatus('Contacts & groups updated.', 'ok');
            })['catch'](function (err) {
              setStatus(err.message, 'bad');
            });
            return;
          case 'Debug log':
            return App.router.push(App.screens.debuglog.create());
          case 'Clear local data':
            App.db.wipe().then(function () {
              localStorage.removeItem('s4k.config');
              App.toast('Local data cleared');
              location.reload();
            });
            return;
        }
      }

      return {
        el: el,
        enter: function () {
          App.softkeys.set('', 'Select', '');
          nav.select(0);
        },
        resume: function () {
          App.softkeys.set('', 'Select', '');
          refreshToggle(receiptsRow);
          refreshToggle(styledRow);
        },
        onKey: function (evt) {
          if (nav.handleKey(evt)) return true;
          if (evt.key === 'Enter') {
            var sel = nav.selected();
            if (!sel) return true;
            onAction(sel.getAttribute('data-id'));
            return true;
          }
          return false;
        }
      };
    }
  };
})();
