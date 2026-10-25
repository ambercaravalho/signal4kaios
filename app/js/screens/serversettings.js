(function () {
  'use strict';

  /* Pairing with the gateway: the gateway's address plus the 8-digit pairing code it prints. Pairing returns a device token and the Signal number(s) on the backend; with several numbers the user picks one.

     create({ firstRun?, unpaired?, addAccount? })
       firstRun   — initial setup (root screen, no Back)
       unpaired   — the gateway stopped accepting this phone; explain and re-pair
       addAccount — blank URL; reuses an existing pairing when the URL matches
     With no options (from Settings) it shows the current pairing and offers Unpair this phone. */

  var DEVICE_NAME = 'KaiOS phone';

  App.screens.serversettings = {
    create: function (opts) {
      opts = opts || {};
      var paired = !opts.firstRun && !opts.addAccount && App.config.isConfigured();

      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title',
        opts.addAccount ? 'Add account' : (paired ? 'Server & connection' : 'Pair with gateway')));
      el.appendChild(hdr);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      function field(labelText, value, placeholder, type) {
        var wrap = App.util.el('div', 'field');
        var label = App.util.el('label', null, labelText);
        var input = App.util.el('input');
        input.type = type || 'text';
        input.value = value || '';
        input.placeholder = placeholder || '';
        // URLs are lowercase/case-exact — stop the KaiOS keypad starting in capitalized "Abc" mode.
        input.setAttribute('autocapitalize', 'none');
        input.setAttribute('autocorrect', 'off');
        input.spellcheck = false;
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

      function note(text) {
        list.appendChild(App.util.el('div', 'field-note', text));
      }

      if (paired) {
        list.appendChild(App.util.sectionHeader('Paired'));
        note('Gateway: ' + App.config.serverUrl());
        note('Signal number: ' + App.config.number());
        action('Unpair this phone', 'Stop this phone connecting to the gateway');
        list.appendChild(App.util.sectionHeader('Pair again'));
      }

      var urlInput = field('Gateway address',
        opts.addAccount ? '' : App.config.serverUrl(), 'http://192.168.1.100:8090');
      var codeInput = field('Pairing code', '', '1234-5678', 'tel');
      note(opts.addAccount
        ? 'Leave the code empty if this phone is already paired with that gateway.'
        : 'The gateway prints the code when it first starts (docker compose logs ' +
          'gateway). Get a new one with: docker compose exec gateway npm run pair');

      var status = App.util.el('div', 'status-line', '');
      list.appendChild(status);

      action('Pair', 'Connect this phone to the gateway');

      var nav = new App.Nav(el, { scrollEl: list });
      // A token from a pairing that found no Signal number yet, reused on retry.
      var pendingToken = null;
      var busy = false;

      function setStatus(text, cls) {
        status.textContent = text;
        status.className = 'status-line' + (cls ? ' ' + cls : '');
      }

      // Turn a failed request into what the user should check. Never includes the code or token: err.message only carries the HTTP status.
      function explain(err) {
        var kind = err && err.kind;
        var code = err && err.status;
        if (kind === 'network' || kind === 'timeout') {
          return (kind === 'timeout' ? 'No answer from the gateway. ' : 'Cannot reach the gateway. ') +
            'Check the address and port (default 8090), that the gateway is ' +
            'running, and that the phone can reach it (same Wi-Fi, or an ' +
            'https:// address from outside).';
        }
        if (code === 403) {
          return 'Wrong or expired pairing code. Get a new one with: ' +
            'docker compose exec gateway npm run pair';
        }
        if (code === 429) return 'Too many attempts. Wait 15 minutes and try again.';
        if (code === 401) return 'The gateway no longer accepts this phone. Enter a new pairing code.';
        if (code === 404) {
          return 'That address answered, but it is not a Signal4KaiOS gateway. ' +
            'Use the gateway address with no extra path.';
        }
        if (code >= 500) {
          return 'HTTP ' + code + ': the gateway is up but signal-cli-rest-api is ' +
            'not responding. Check the backend containers.';
        }
        return (err && err.message) || 'Pairing failed';
      }

      function finish(url, token, number) {
        var oldToken = App.config.serverUrl() === url ? App.config.deviceToken() : '';
        App.config.set({ serverUrl: url, number: number, deviceToken: token });
        App.config.setServerToken(url, token);
        App.config.saveActiveAccount();
        App.toast('Paired');
        // Re-pairing replaces this phone's old token; revoke it best-effort.
        var revokeOld = oldToken && oldToken !== token
          ? App.http.post('/v1/pair/revoke', {}, { baseUrl: url, authToken: oldToken })['catch'](function () {})
          : Promise.resolve();
        revokeOld.then(function () { location.reload(); });
      }

      function chooseNumber(url, token, numbers) {
        if (!numbers.length) {
          pendingToken = { url: url, token: token };
          setStatus('Paired, but no Signal account is linked on the backend yet. ' +
            'Link one (see the setup guide), then press Pair again.', 'bad');
          return;
        }
        if (numbers.length === 1) {
          finish(url, token, numbers[0]);
          return;
        }
        var current = App.config.number();
        App.router.push(App.screens.menu.create({
          title: 'Choose number',
          items: numbers.map(function (n) {
            return {
              label: n + (n === current ? ' (current)' : ''),
              onSelect: function () {
                finish(url, token, n);
                return 'keep';
              }
            };
          })
        }));
      }

      function pair() {
        if (busy) return;
        var url = urlInput.value.trim().replace(/\/+$/, '');
        var code = codeInput.value.replace(/\D/g, '');
        if (!/^https?:\/\/[^\s/]+/.test(url)) {
          setStatus('Gateway address must start with http:// or https://', 'bad');
          return;
        }
        var reuse = (pendingToken && pendingToken.url === url && pendingToken.token) ||
          (opts.addAccount ? App.config.tokenForServer(url) : '');
        if (!code && !reuse) {
          setStatus('Enter the 8-digit pairing code from the gateway.', 'bad');
          return;
        }
        if (code && code.length !== 8) {
          setStatus('The pairing code has 8 digits.', 'bad');
          return;
        }
        busy = true;
        setStatus('Connecting\u2026');
        App.api.health(url).then(function (h) {
          if (!h || h.gateway !== 'signal4kaios') {
            var notGateway = new Error('not a gateway');
            notGateway.status = 404;
            throw notGateway;
          }
          if (code) {
            setStatus('Pairing\u2026');
            return App.api.pair(url, code, DEVICE_NAME).then(function (res) {
              if (!res || !res.token) throw new Error('Unexpected reply from the gateway');
              return { token: res.token, numbers: res.numbers || [] };
            });
          }
          return App.api.accounts(url, reuse).then(function (numbers) {
            return { token: reuse, numbers: numbers || [] };
          });
        }).then(function (r) {
          busy = false;
          var numbers = (r.numbers || []).filter(function (n) { return typeof n === 'string'; });
          chooseNumber(url, r.token, numbers);
        })['catch'](function (err) {
          busy = false;
          setStatus(explain(err), 'bad');
        });
      }

      function unpair() {
        App.dialog.confirm({
          title: 'Unpair this phone?',
          message: 'It stops receiving messages until you pair it again with a new code.',
          confirmLabel: 'Unpair',
          onConfirm: function () {
            var url = App.config.serverUrl();
            App.api.unpair()['catch'](function () { /* offline: forget locally anyway */ })
              .then(function () {
                App.ws.stop();
                App.config.forgetPairing(url);
                location.reload();
              });
          }
        });
      }

      function onAction(id) {
        if (id === 'Pair') return pair();
        if (id === 'Unpair this phone') return unpair();
      }

      function softkeys() {
        App.softkeys.set(opts.firstRun ? '' : 'Back', 'Select', '');
      }

      return {
        el: el,
        enter: function () {
          softkeys();
          if (opts.unpaired) {
            setStatus('This phone is no longer paired with the gateway. Enter a new pairing code.', 'bad');
          } else if (opts.firstRun) {
            setStatus('Enter the gateway address and the pairing code it shows.');
          } else if (opts.addAccount) {
            setStatus('Enter the gateway address for the new account.');
          }
          nav.select(0);
        },
        resume: softkeys,
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
