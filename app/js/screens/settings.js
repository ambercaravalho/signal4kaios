(function () {
  'use strict';

  /* Main settings menu. The signal-cli-rest-api connection fields live in their
     own screen (App.screens.serversettings); everything here is a menu action,
     a boolean toggle (checkbox), or a value selector. */

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

      /* A menu-item with a trailing checkbox reflecting a boolean config flag.
         Enter toggles it (handled generically via row.__toggle). */
      function toggle(label, getFn, setFn) {
        var row = App.util.el('div', 'menu-item toggle');
        row.setAttribute('nav-selectable', 'true');
        row.setAttribute('data-id', label);
        row.appendChild(App.util.el('span', 'toggle-label', label));
        row.appendChild(App.util.el('span', 'opt-mark check'));
        row.__toggle = { get: getFn, set: setFn };
        syncToggle(row);
        list.appendChild(row);
        return row;
      }

      function syncToggle(row) {
        if (!row || !row.__toggle) return;
        if (row.__toggle.get()) row.classList.add('on');
        else row.classList.remove('on');
      }

      function themeLabel() {
        return App.theme.current() === 'light' ? 'Light' : 'Dark';
      }

      list.appendChild(App.util.sectionHeader('Server'));
      action('Server & connection', 'URL, number, proxy auth');

      list.appendChild(App.util.sectionHeader('Appearance'));
      var themeRow = action('Theme', themeLabel());

      list.appendChild(App.util.sectionHeader('Privacy'));
      var receiptsRow = toggle('Read receipts',
        function () { return App.config.sendReadReceipts(); },
        function (v) { App.config.set({ sendReadReceipts: v }); });
      var typingRow = toggle('Typing indicators',
        function () { return App.config.typingIndicators(); },
        function (v) { App.config.set({ typingIndicators: v }); });
      action('Blocked', 'People and groups you have blocked');

      list.appendChild(App.util.sectionHeader('Chats'));
      var mutedArchiveRow = toggle('Keep muted chats archived',
        function () { return App.config.keepMutedArchived(); },
        function (v) { App.config.set({ keepMutedArchived: v }); });

      list.appendChild(App.util.sectionHeader('Composer'));
      var styledRow = toggle('Text formatting',
        function () { return App.config.styledText(); },
        function (v) { App.config.set({ styledText: v }); });

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

      function refreshThemeRow() {
        var hint = themeRow.querySelector('.hint');
        if (hint) hint.textContent = themeLabel();
      }

      function chooseTheme() {
        App.valueSelector.open({
          title: 'Theme',
          selected: App.theme.current(),
          options: [
            { label: 'Dark', value: 'dark' },
            { label: 'Light', value: 'light' }
          ],
          onPick: function (v) {
            App.theme.set(v);
            refreshThemeRow();
          }
        });
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
          case 'Theme':
            return chooseTheme();
          case 'Blocked':
            return App.router.push(App.screens.blocked.create());
          case 'Edit profile':
            return App.router.push(App.screens.profile.create());
          case 'Switch account':
            return accountSwitcher();
          case 'Refresh contacts & groups':
            setStatus('Refreshing\u2026');
            App.store.refreshDirectory().then(function () {
              setStatus('Contacts & groups updated.', 'ok');
            })['catch'](function (err) {
              setStatus(err.message, 'bad');
            });
            return;
          case 'Debug log':
            return App.router.push(App.screens.debuglog.create());
          case 'Clear local data':
            App.dialog.confirm({
              title: 'Clear local data?',
              message: 'Deletes cached messages and settings on this phone.',
              confirmLabel: 'Clear',
              onConfirm: function () {
                App.db.wipe().then(function () {
                  localStorage.removeItem('s4k.config');
                  App.toast('Local data cleared');
                  location.reload();
                });
              }
            });
            return;
        }
      }

      return {
        el: el,
        enter: function () {
          App.softkeys.set('QR code', 'Select', '');
          nav.select(0);
        },
        resume: function () {
          App.softkeys.set('QR code', 'Select', '');
          refreshThemeRow();
          syncToggle(receiptsRow);
          syncToggle(typingRow);
          syncToggle(mutedArchiveRow);
          syncToggle(styledRow);
        },
        onKey: function (evt) {
          if (evt.key === 'SoftLeft') {
            App.screens.profile.showQr();
            return true;
          }
          if (nav.handleKey(evt)) return true;
          if (evt.key === 'Enter') {
            var sel = nav.selected();
            if (!sel) return true;
            if (sel.__toggle) {
              sel.__toggle.set(!sel.__toggle.get());
              syncToggle(sel);
              return true;
            }
            onAction(sel.getAttribute('data-id'));
            return true;
          }
          return false;
        }
      };
    }
  };
})();
