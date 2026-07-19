(function () {
  'use strict';

  /* Background notifications (Web Push) settings. Points the phone at a push
     bridge server and enables/disables the subscription. The bridge is a
     separate component that watches signal-cli and sends pushes; see
     docs/push-bridge.md. Notifications delivered this way arrive even when the
     app is fully closed. */

  App.screens.pushsettings = {
    create: function () {
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'Background notifications'));
      el.appendChild(hdr);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      var cfg = App.config.get();

      function field(labelText, value, placeholder, type) {
        var wrap = App.util.el('div', 'field');
        wrap.appendChild(App.util.el('label', null, labelText));
        var input = App.util.el('input');
        input.type = type || 'text';
        input.value = value || '';
        input.placeholder = placeholder || '';
        input.setAttribute('nav-selectable', 'true');
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

      if (!App.push.supported()) {
        list.appendChild(App.util.el('div', 'field-note',
          'This device has no Push support (KaiOS 3.0+ only). Notifications ' +
          'will only arrive while the app is open.'));
      }

      var urlInput = field('Push bridge URL', cfg.pushBridgeUrl,
        'https://push.example.com');
      var keyInput = field('VAPID public key', cfg.pushVapidKey,
        'base64url (recommended)');
      var tokenInput = field('Bridge token', cfg.pushBridgeToken,
        'optional', 'password');

      list.appendChild(App.util.el('div', 'field-note',
        'The bridge holds the signal-cli receive connection open and turns each ' +
        'incoming message into a push, so notifications work with the app ' +
        'closed. Without a bridge, this does nothing. See docs/push-bridge.md.'));

      var enableRow = action('Enable', '');
      var status = App.util.el('div', 'status-line', '');
      list.appendChild(status);

      var nav = new App.Nav(el, { scrollEl: list });

      function setStatus(text, cls) {
        status.textContent = text;
        status.className = 'status-line' + (cls ? ' ' + cls : '');
      }

      function refreshEnableRow() {
        var on = App.config.pushEnabled();
        enableRow.firstChild.nodeValue = on ? 'Disable' : 'Enable';
        enableRow.setAttribute('data-id', on ? 'Disable' : 'Enable');
        var hint = enableRow.querySelector('.hint');
        var text = on ? 'Background notifications are on' :
          'Turn on background notifications';
        if (hint) hint.textContent = text;
        else enableRow.appendChild(App.util.el('span', 'hint', text));
      }

      function saveFields() {
        App.config.set({
          pushBridgeUrl: urlInput.value.trim().replace(/\/+$/, ''),
          pushVapidKey: keyInput.value.trim(),
          pushBridgeToken: tokenInput.value
        });
      }

      function enable() {
        saveFields();
        setStatus('Subscribing\u2026');
        App.push.enable().then(function (host) {
          setStatus('Enabled via ' + host, 'ok');
          App.toast('Background notifications on');
          refreshEnableRow();
        })['catch'](function (err) {
          setStatus(err.message, 'bad');
        });
      }

      function disable() {
        setStatus('Disabling\u2026');
        App.push.disable().then(function () {
          setStatus('Disabled.', 'ok');
          App.toast('Background notifications off');
          refreshEnableRow();
        })['catch'](function (err) {
          setStatus(err.message, 'bad');
        });
      }

      function onAction(id) {
        if (id === 'Enable') return enable();
        if (id === 'Disable') return disable();
      }

      refreshEnableRow();

      return {
        el: el,
        enter: function () {
          App.softkeys.set('Back', 'Select', '');
          nav.select(0);
        },
        resume: function () {
          App.softkeys.set('Back', 'Select', '');
          refreshEnableRow();
        },
        onKey: function (evt) {
          var active = document.activeElement;
          var inInput = active && active.tagName === 'INPUT';
          if ((evt.key === 'ArrowLeft' || evt.key === 'ArrowRight') && inInput) {
            return false;
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
