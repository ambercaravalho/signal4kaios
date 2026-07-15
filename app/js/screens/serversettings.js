(function () {
  'use strict';

  /* Server & connection settings: the signal-cli-rest-api URL, your Signal
     number, and optional reverse-proxy credentials, plus Save / Test. Split out
     of the main Settings menu so the everyday options stay uncluttered.

     create({ firstRun?, addAccount? }) — firstRun is the initial setup screen;
     addAccount starts with blank fields to add another number. */

  App.screens.serversettings = {
    create: function (opts) {
      opts = opts || {};
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title',
        opts.addAccount ? 'Add account' : 'Server & connection'));
      el.appendChild(hdr);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      // In "add account" mode start with blank fields so a new account can be
      // entered without clobbering the current one until Save.
      var cfg = opts.addAccount ? {} : App.config.get();

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

      function action(label, hint) {
        var row = App.util.el('div', 'menu-item', label);
        row.setAttribute('nav-selectable', 'true');
        row.setAttribute('data-id', label);
        if (hint) row.appendChild(App.util.el('span', 'hint', hint));
        list.appendChild(row);
        return row;
      }

      var urlInput = field('Server URL', cfg.serverUrl, 'http://192.168.1.100:4329');
      var numInput = field('My Signal number', cfg.number, '+15551234567');
      var authUserInput = field('Reverse proxy username (optional)', cfg.authUser,
        'leave blank if not needed');
      var authPassInput = field('Reverse proxy password', cfg.authPass,
        '', 'password');
      var recvTokenInput = field('Receive token (optional)', cfg.receiveToken,
        'Pangolin access token: id.secret');
      list.appendChild(App.util.el('div', 'field-note',
        'Basic Auth only secures the HTTP API. A browser WebSocket cannot send ' +
        'it, so live updates need the /v1/receive path authenticated another ' +
        'way. Paste a Pangolin Resource Access Token here (in <id>.<secret> ' +
        'form); it is sent as ?p_token. Or exempt the path and lock it down at ' +
        'the network level — see docs/remote-access.md.'));

      var status = App.util.el('div', 'status-line', '');
      list.appendChild(status);

      action('Save', 'Store settings and reconnect');
      action('Test connection', 'Ping the signal-cli-rest-api server');

      var nav = new App.Nav(el, { scrollEl: list });

      function setStatus(text, cls) {
        status.textContent = text;
        status.className = 'status-line' + (cls ? ' ' + cls : '');
      }

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
        var prevNumber = App.config.number();
        App.config.set({
          serverUrl: url,
          number: n,
          authUser: authUserInput.value.trim(),
          authPass: authPassInput.value,
          receiveToken: recvTokenInput.value.trim()
        });
        App.config.saveActiveAccount();
        setStatus('Saved.', 'ok');
        App.toast('Settings saved');

        // Switching to a different account (or first setup) changes which
        // IndexedDB and WebSocket we use, so reload to reinitialize cleanly.
        if (opts.addAccount || opts.firstRun || n !== prevNumber) {
          location.reload();
          return;
        }
        App.ws.restart();
        App.store.refreshDirectory()['catch'](function () { /* offline is fine */ });
      }

      function testConnection() {
        // Use current field values so testing works before saving.
        App.config.set({
          serverUrl: urlInput.value.trim().replace(/\/+$/, ''),
          number: normalizedNumber(),
          authUser: authUserInput.value.trim(),
          authPass: authPassInput.value,
          receiveToken: recvTokenInput.value.trim()
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
        if (id === 'Save') return save();
        if (id === 'Test connection') return testConnection();
      }

      return {
        el: el,
        enter: function () {
          // First-run is the root screen (nothing to go back to); otherwise the
          // left key is the cohesive Back.
          App.softkeys.set(opts.firstRun ? '' : 'Back', 'Select', '');
          if (opts.firstRun) {
            setStatus('Welcome! Enter your signal-cli-rest-api server URL and number.');
          } else if (opts.addAccount) {
            setStatus('Enter the server URL and number for the new account.');
          }
          nav.select(0);
        },
        resume: function () {
          App.softkeys.set(opts.firstRun ? '' : 'Back', 'Select', '');
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
