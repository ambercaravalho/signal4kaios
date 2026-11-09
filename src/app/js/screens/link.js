(function () {
  'use strict';

  /* Link with Signal (`App.screens.link`):
     Connects directly to Signal's provisioning WebSocket (`wss://chat.signal.org/v1/websocket/provisioning/`),
     renders the `sgnl://linkdevice` QR code on the phone screen, decrypts the provisioning envelope on-device,
     uploads PreKeys, and requests an initial contact/group sync from the primary phone.

     When opened from Settings while already linked, displays account details, PreKey replenishment,
     contact/group sync request, and Unlink this phone. */

  var DEFAULT_DEVICE_NAME = 'Signal4KaiOS';

  App.screens.link = {
    create: function (opts) {
      opts = opts || {};
      var linked = !opts.firstRun && !opts.addAccount && App.config.isConfigured();

      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title',
        opts.addAccount ? 'Add account' : (linked ? 'Linked account' : 'Link with Signal')));
      el.appendChild(hdr);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      var provSession = null;

      function field(labelText, value, placeholder) {
        var wrap = App.util.el('div', 'field');
        var label = App.util.el('label', null, labelText);
        var input = App.util.el('input');
        input.type = 'text';
        input.value = value || '';
        input.placeholder = placeholder || '';
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

      if (linked) {
        list.appendChild(App.util.sectionHeader('Linked device'));
        note('Signal number: ' + (App.config.number() || 'Linked'));
        if (App.config.aci()) note('Account UUID: ' + App.config.aci());
        note('Device ID: ' + App.config.deviceId());
        action('Sync contacts & groups', 'Request latest directory from primary phone');
        action('Refresh PreKeys', 'Upload fresh encryption PreKeys');
        action('Unlink this phone', 'Remove this linked device and local keys');
        list.appendChild(App.util.sectionHeader('Relink'));
      }

      var qrBox = App.util.el('div', 'qr-box');
      qrBox.setAttribute('nav-selectable', 'true');
      qrBox.setAttribute('data-id', 'Generate QR code');
      list.appendChild(qrBox);

      var status = App.util.el('div', 'status-line', '');
      list.appendChild(status);

      var nameInput = field('Device name', DEFAULT_DEVICE_NAME, 'Signal4KaiOS');
      note('Open Signal on your main phone \u2192 Settings \u2192 Linked devices \u2192 Link a new device, then scan the QR code above.');

      action('Generate QR code', 'Start a new linking QR session');

      var nav = new App.Nav(el, { scrollEl: list });

      function setStatus(text, cls) {
        status.textContent = text;
        status.className = 'status-line' + (cls ? ' ' + cls : '');
      }

      function renderQrImage(sgnlUri) {
        qrBox.textContent = '';
        if (typeof qrcode === 'undefined') {
          qrBox.appendChild(App.util.el('div', 'field-note', sgnlUri));
          return;
        }
        try {
          var qr = qrcode(0, 'L');
          qr.addData(sgnlUri);
          qr.make();
          var img = App.util.el('img', 'qr-img welcome-qr');
          img.src = qr.createDataURL(4, 2);
          qrBox.appendChild(img);
        } catch (e) {
          App.util.dbg('link qr render failed: ' + e.message);
          qrBox.appendChild(App.util.el('div', 'field-note', sgnlUri));
        }
      }

      function stopProvisioning() {
        if (provSession) {
          provSession.cancel();
          provSession = null;
        }
      }

      function startLinking() {
        stopProvisioning();
        if (!App.signal || !App.signal.startProvisioning) {
          setStatus('Signal encryption engine not loaded.', 'bad');
          return;
        }
        qrBox.textContent = '';
        qrBox.appendChild(App.util.el('div', 'field-note', 'Connecting to Signal\u2026'));
        setStatus('Connecting to Signal provisioning service\u2026');

        var devName = (nameInput.value || '').trim() || DEFAULT_DEVICE_NAME;
        var switchedDb = false;
        provSession = App.signal.startProvisioning(devName, {
          onStatus: function (msg) {
            setStatus(msg);
          },
          onQrUrl: function (sgnlUri) {
            renderQrImage(sgnlUri);
            setStatus('Scan this QR code from Signal \u2192 Linked devices.');
          },
          beforeLinking: function (account) {
            App.ws.stop();
            switchedDb = true;
            return App.db.useAccount(account.number || account.aci);
          },
          onLinked: function (creds) {
            provSession = null;
            App.config.set({
              number: creds.number || creds.aci,
              aci: creds.aci,
              deviceId: creds.deviceId,
              deviceToken: creds.password
            });
            App.config.saveActiveAccount();
            setStatus('Linked! Requesting contact & group sync\u2026', 'ok');
            App.toast('Linked with Signal');
            App.signal.requestSync()['catch'](function () {}).then(function () {
              location.reload();
            });
          },
          onError: function (err) {
            provSession = null;
            setStatus((err && err.message) || 'Linking failed. Press Generate QR code to retry.', 'bad');
            if (switchedDb) {
              switchedDb = false;
              App.db.useAccount(null).then(function () {
                if (App.config.isConfigured()) App.ws.connect();
              });
            }
          }
        });
      }

      function unlink() {
        App.dialog.confirm({
          title: 'Unlink this phone?',
          message: 'Deletes encryption keys and messages stored on this phone.',
          confirmLabel: 'Unlink',
          onConfirm: function () {
            stopProvisioning();
            App.ws.stop();
            App.api.unlink().then(function () {
              App.config.forgetAccount();
              location.reload();
            });
          }
        });
      }

      function onAction(id) {
        if (id === 'Generate QR code') return startLinking();
        if (id === 'Unlink this phone') return unlink();
        if (id === 'Sync contacts & groups') {
          setStatus('Requesting sync from primary device\u2026');
          App.signal.requestSync().then(function () {
            setStatus('Sync requested. Make sure your main phone is online.', 'ok');
          })['catch'](function (e) {
            setStatus((e && e.message) || 'Sync request failed', 'bad');
          });
          return;
        }
        if (id === 'Refresh PreKeys') {
          setStatus('Uploading PreKeys\u2026');
          App.signal.replenishPreKeys().then(function () {
            setStatus('PreKeys refreshed.', 'ok');
          })['catch'](function (e) {
            setStatus((e && e.message) || 'PreKey upload failed', 'bad');
          });
        }
      }

      function softkeys() {
        App.softkeys.set(opts.firstRun ? '' : 'Back', 'Select', 'Refresh QR');
      }

      return {
        el: el,
        enter: function () {
          softkeys();
          if (opts.unlinked) {
            setStatus('This phone was unlinked from your Signal account. Scan the QR code to link again.', 'bad');
          }
          nav.select(0);
          if (!linked || opts.firstRun || opts.addAccount || opts.unlinked) {
            startLinking();
          }
        },
        resume: softkeys,
        destroy: stopProvisioning,
        onKey: function (evt) {
          var active = document.activeElement;
          var inInput = active && active.tagName === 'INPUT';

          if (evt.key === 'SoftRight') {
            startLinking();
            return true;
          }
          if (evt.key === 'ArrowLeft' || evt.key === 'ArrowRight') {
            if (inInput) return false;
          }
          if (nav.handleKey(evt)) return true;
          if (evt.key === 'Enter') {
            var sel = nav.selected();
            if (!sel) return true;
            if (sel.tagName === 'INPUT') {
              nav.move(1);
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
