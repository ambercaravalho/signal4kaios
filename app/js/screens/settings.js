(function () {
  'use strict';

  App.screens.settings = {
    create: function (opts) {
      opts = opts || {};
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'Settings'));
      el.appendChild(hdr);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      var cfg = App.config.get();

      function field(labelText, value, placeholder, type) {
        var wrap = App.util.el('div', 'field');
        var label = App.util.el('label', null, labelText);
        var input = App.util.el('input');
        input.type = type || 'text';
        input.value = value || '';
        input.placeholder = placeholder || '';
        input.setAttribute('nav-selectable', 'true');
        wrap.appendChild(label);
        wrap.appendChild(input);
        list.appendChild(wrap);
        return input;
      }

      var urlInput = field('Server URL', cfg.serverUrl, 'http://192.168.1.100:4329');
      var numInput = field('My Signal number', cfg.number, '+15551234567');
      var authUserInput = field('Reverse proxy username (optional)', cfg.authUser,
        'leave blank if not needed');
      var authPassInput = field('Reverse proxy password', cfg.authPass,
        '', 'password');

      var status = App.util.el('div', 'status-line', '');
      list.appendChild(status);

      function setStatus(text, cls) {
        status.textContent = text;
        status.className = 'status-line' + (cls ? ' ' + cls : '');
      }

      function action(label, hint) {
        var row = App.util.el('div', 'menu-item', label);
        row.setAttribute('nav-selectable', 'true');
        row.setAttribute('data-id', label);
        if (hint) row.appendChild(App.util.el('span', 'hint', hint));
        list.appendChild(row);
        return row;
      }

      action('Save', 'Store settings and reconnect');
      action('Test connection', 'Ping the signal-cli-rest-api server');
      action('Refresh contacts & groups');
      action('Debug log');
      action('Clear local data', 'Deletes cached messages on this phone');

      var nav = new App.Nav(el, { scrollEl: list });

      function normalizedNumber() {
        var n = numInput.value.trim().replace(/[\s()-]/g, '');
        if (n && n.charAt(0) !== '+') n = '+' + n;
        return n;
      }

      function save() {
        var url = urlInput.value.trim().replace(/\/+$/, '');
        var n = normalizedNumber();
        if (!/^https?:\/\//.test(url)) {
          setStatus('Server URL must start with http://', 'bad');
          return;
        }
        if (!/^\+\d{6,16}$/.test(n)) {
          setStatus('Number must look like +15551234567', 'bad');
          return;
        }
        App.config.set({
          serverUrl: url,
          number: n,
          authUser: authUserInput.value.trim(),
          authPass: authPassInput.value
        });
        setStatus('Saved.', 'ok');
        App.toast('Settings saved');
        App.ws.restart();
        App.store.refreshDirectory()['catch'](function () { /* offline is fine */ });
        if (opts.firstRun) {
          App.router.replace(App.screens.conversations.create());
        }
      }

      function testConnection() {
        // Use current field values so testing works before saving.
        App.config.set({
          serverUrl: urlInput.value.trim().replace(/\/+$/, ''),
          number: normalizedNumber(),
          authUser: authUserInput.value.trim(),
          authPass: authPassInput.value
        });
        setStatus('Testing…');
        App.api.about().then(function (info) {
          var v = info && info.version ? ' v' + info.version : '';
          var mode = info && info.mode ? ' (' + info.mode + ' mode)' : '';
          setStatus('Connected' + v + mode, 'ok');
        })['catch'](function (err) {
          setStatus(err.message, 'bad');
        });
      }

      function onAction(id) {
        switch (id) {
          case 'Save':
            return save();
          case 'Test connection':
            return testConnection();
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
          if (opts.firstRun) {
            setStatus('Welcome! Enter your signal-cli-rest-api server URL and number.');
          }
          nav.select(0);
        },
        resume: function () {
          App.softkeys.set('', 'Select', '');
        },
        onKey: function (evt) {
          var active = document.activeElement;
          var inInput = active && active.tagName === 'INPUT';

          if (evt.key === 'ArrowLeft' || evt.key === 'ArrowRight') {
            if (inInput) return false; // move the text cursor
          }
          if (nav.handleKey(evt)) return true;
          if (evt.key === 'Enter') {
            var sel = nav.selected();
            if (!sel) return true;
            if (sel.tagName === 'INPUT') {
              nav.move(1); // jump to the next field/action
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
