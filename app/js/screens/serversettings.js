(function () {
  'use strict';

  /* Server & connection settings: the signal-cli-rest-api URL, your Signal
     number, and the connection auth mode (with its credentials), plus Save /
     Test. Split out of the main Settings menu so the everyday options stay
     uncluttered.

     create({ firstRun?, addAccount? }) — firstRun is the initial setup screen;
     addAccount starts with blank fields to add another number. */

  var MODE_LABEL = {
    none: 'Unauthenticated',
    basic: 'Basic header auth',
    token: 'Receive token'
  };

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

      // Current mode + a draft of every credential so switching modes back and
      // forth within the session doesn't lose what was typed.
      var mode = cfg.authMode || 'none';
      var draft = {
        authUser: cfg.authUser || '',
        authPass: cfg.authPass || '',
        receiveToken: cfg.receiveToken || '',
        tokenParam: cfg.tokenParam || 'token'
      };
      // Live input refs for the currently-rendered credential fields.
      var inputs = {};

      function field(parent, labelText, value, placeholder, type) {
        var wrap = App.util.el('div', 'field');
        var label = App.util.el('label', null, labelText);
        var input = App.util.el('input');
        input.type = type || 'text';
        input.value = value || '';
        input.placeholder = placeholder || '';
        input.setAttribute('nav-selectable', 'true');
        wrap.appendChild(label);
        wrap.appendChild(input);
        parent.appendChild(wrap);
        return input;
      }

      function action(parent, label, hint) {
        var row = App.util.el('div', 'menu-item', label);
        row.setAttribute('nav-selectable', 'true');
        row.setAttribute('data-id', label);
        if (hint) row.appendChild(App.util.el('span', 'hint', hint));
        parent.appendChild(row);
        return row;
      }

      function clear(node) {
        while (node.firstChild) node.removeChild(node.firstChild);
      }

      var urlInput = field(list, 'Server URL', cfg.serverUrl,
        'http://192.168.1.100:4329');
      var numInput = field(list, 'My Signal number', cfg.number, '+15551234567');

      var modeRow = action(list, 'Connection security', MODE_LABEL[mode]);
      var modeHint = modeRow.querySelector('.hint');

      // Credential fields + explanatory note for the current mode live here and
      // are rebuilt whenever the mode changes.
      var credsWrap = App.util.el('div');
      list.appendChild(credsWrap);

      var status = App.util.el('div', 'status-line', '');
      list.appendChild(status);

      action(list, 'Save', 'Store settings and reconnect');
      action(list, 'Test connection', 'Ping the signal-cli-rest-api server');

      var nav = new App.Nav(el, { scrollEl: list });

      // Capture whatever is typed in the current credential inputs into `draft`
      // so it survives a mode switch (and a re-render).
      function captureInputs() {
        if (inputs.authUser) draft.authUser = inputs.authUser.value.trim();
        if (inputs.authPass) draft.authPass = inputs.authPass.value;
        if (inputs.receiveToken) draft.receiveToken = inputs.receiveToken.value.trim();
        if (inputs.tokenParam) draft.tokenParam = inputs.tokenParam.value.trim();
      }

      function renderCreds() {
        clear(credsWrap);
        inputs = {};
        if (mode === 'basic') {
          inputs.authUser = field(credsWrap, 'Proxy username', draft.authUser,
            'reverse-proxy user');
          inputs.authPass = field(credsWrap, 'Proxy password', draft.authPass,
            '', 'password');
          credsWrap.appendChild(App.util.el('div', 'field-note',
            'Password-protects the HTTP API, but a browser cannot send Basic ' +
            'Auth on the WebSocket, so live updates are left unauthenticated. ' +
            'Lock down /v1/receive separately, or use Receive token instead.'));
        } else if (mode === 'token') {
          inputs.receiveToken = field(credsWrap, 'Receive token', draft.receiveToken,
            'secret sent with every request', 'password');
          inputs.tokenParam = field(credsWrap, 'Token query param',
            draft.tokenParam || 'token', 'token (use p_token for Pangolin)');
          credsWrap.appendChild(App.util.el('div', 'field-note',
            'The token is sent as ?<param>=<token> on every request, including ' +
            'the WebSocket, so the proxy authenticates both the API and live ' +
            'updates with one secret. Use HTTPS/WSS. For Pangolin set the ' +
            'param to p_token.'));
        } else {
          credsWrap.appendChild(App.util.el('div', 'field-note',
            'No authentication. Anyone who can reach the server can read your ' +
            'messages and send as you. Use only on a trusted home network or ' +
            'private VPN.'));
        }
      }

      function chooseMode() {
        captureInputs();
        App.router.push(App.screens.menu.create({
          title: 'Connection security',
          items: [
            {
              label: 'Unauthenticated',
              hint: 'No login. Anyone who can reach the server can read/send. Home/VPN only.',
              onSelect: function () { setMode('none'); }
            },
            {
              label: 'Basic header auth',
              hint: 'Password-protects the API, but leaves the live WebSocket unauthenticated.',
              onSelect: function () { setMode('basic'); }
            },
            {
              label: 'Receive token',
              hint: 'One token on every request, including the WebSocket. Best option.',
              onSelect: function () { setMode('token'); }
            }
          ]
        }));
      }

      function setMode(m) {
        mode = m;
        modeHint.textContent = MODE_LABEL[mode];
        renderCreds();
      }

      function setStatus(text, cls) {
        status.textContent = text;
        status.className = 'status-line' + (cls ? ' ' + cls : '');
      }

      function normalizedNumber() {
        var n = numInput.value.trim().replace(/[\s()-]/g, '');
        if (n && n.charAt(0) !== '+') n = '+' + n;
        return n;
      }

      // Build the auth-related config patch for the current mode, blanking the
      // fields that don't apply so a mode switch fully replaces the old creds.
      function authPatch() {
        captureInputs();
        var patch = {
          authMode: mode,
          authUser: '',
          authPass: '',
          receiveToken: '',
          tokenParam: ''
        };
        if (mode === 'basic') {
          patch.authUser = draft.authUser;
          patch.authPass = draft.authPass;
        } else if (mode === 'token') {
          patch.receiveToken = draft.receiveToken;
          patch.tokenParam = draft.tokenParam || 'token';
        }
        return patch;
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
        App.config.set(Object.assign({ serverUrl: url, number: n }, authPatch()));
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
        App.config.set(Object.assign({
          serverUrl: urlInput.value.trim().replace(/\/+$/, ''),
          number: normalizedNumber()
        }, authPatch()));
        setStatus('Testing…');
        App.api.about().then(function (info) {
          var v = info && info.version ? ' v' + info.version : '';
          var modeStr = info && info.mode ? ' (' + info.mode + ' mode)' : '';
          setStatus('Connected' + v + modeStr, 'ok');
        })['catch'](function (err) {
          setStatus(err.message, 'bad');
        });
      }

      function onAction(id) {
        if (id === 'Connection security') return chooseMode();
        if (id === 'Save') return save();
        if (id === 'Test connection') return testConnection();
      }

      renderCreds();

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
