(function () {
  'use strict';

  /* Welcome / setup help: explains that the app needs a self-hosted backend before asking for connection details. Shown on first run (unconfigured), and from Settings -> About & setup help.

     create({ firstRun? }) — firstRun ends in the server settings screen; otherwise the last page's Done pops back. */

  var GUIDE_URL = 'https://github.com/ambercaravalho/signal4kaios/blob/main/docs/setup.md';

  var PAGES = [
    {
      title: 'Welcome',
      lines: [
        'Signal4KaiOS is a Signal client. Your Signal account does not live on ' +
          'this phone: it runs on a backend that you host yourself.',
        'You need a computer or server (home PC, Raspberry Pi, or VPS) running ' +
          'two Docker containers: signal-cli-rest-api and the Signal4KaiOS gateway.'
      ]
    },
    {
      title: 'Before you continue',
      lines: [
        '1. Start the backend with Docker Compose (see the setup guide).',
        '2. Link your Signal account to it as a linked device, like Signal Desktop.',
        '3. Note the gateway address (e.g. http://192.168.1.100:8090) and the ' +
          'pairing code it prints when it starts.',
        'Then enter both on the next screen. Your Signal number is picked up ' +
          'from the backend automatically.'
      ]
    },
    {
      title: 'Setup guide',
      qr: true,
      lines: [
        'Scan this with another phone or computer to read the full setup ' +
          'guide, or press Open guide.'
      ]
    }
  ];

  App.screens.welcome = {
    create: function (opts) {
      opts = opts || {};
      var page = 0;

      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      var title = App.util.el('span', 'hdr-title', '');
      var counter = App.util.el('span', 'hdr-sub', '');
      hdr.appendChild(title);
      hdr.appendChild(counter);
      el.appendChild(hdr);

      var body = App.util.el('div', 'list welcome');
      el.appendChild(body);

      var versionText = '';
      App.util.appVersion().then(function (v) {
        versionText = v ? 'Signal4KaiOS v' + v : '';
        var line = body.querySelector('.welcome-version');
        if (line) line.textContent = versionText;
      });

      function isLast() { return page === PAGES.length - 1; }

      function renderQr() {
        var box = App.util.el('div', 'qr-box');
        if (typeof qrcode === 'undefined') {
          box.appendChild(App.util.el('div', 'field-note', 'QR generator unavailable.'));
        } else {
          try {
            var qr = qrcode(0, 'L');
            qr.addData(GUIDE_URL);
            qr.make();
            var img = App.util.el('img', 'qr-img welcome-qr');
            img.src = qr.createDataURL(4, 2);
            box.appendChild(img);
          } catch (e) {
            App.util.dbg('welcome qr render failed: ' + e.message);
          }
        }
        box.appendChild(App.util.el('div', 'welcome-url', GUIDE_URL));
        return box;
      }

      function setSoftkeys() {
        var left = page > 0 ? 'Previous' : (opts.firstRun ? '' : 'Back');
        var center = isLast() ? (opts.firstRun ? 'Set up' : 'Done') : 'Next';
        var right = isLast() ? 'Open guide' : (opts.firstRun ? 'Skip' : '');
        App.softkeys.set(left, center, right);
      }

      function render() {
        var p = PAGES[page];
        title.textContent = p.title;
        counter.textContent = (page + 1) + '/' + PAGES.length;
        body.textContent = '';
        if (p.qr) body.appendChild(renderQr());
        p.lines.forEach(function (text) {
          body.appendChild(App.util.el('p', 'welcome-text', text));
        });
        body.appendChild(App.util.el('div', 'welcome-version', versionText));
        body.scrollTop = 0;
        setSoftkeys();
      }

      function finish() {
        if (opts.firstRun) {
          App.router.push(App.screens.serversettings.create({ firstRun: true }));
        } else {
          App.router.pop();
        }
      }

      function go(delta) {
        var next = page + delta;
        if (next < 0 || next >= PAGES.length) return;
        page = next;
        render();
      }

      return {
        el: el,
        enter: render,
        resume: setSoftkeys,
        onKey: function (evt) {
          switch (evt.key) {
            case 'ArrowDown':
              body.scrollTop += 40;
              return true;
            case 'ArrowUp':
              body.scrollTop -= 40;
              return true;
            case 'ArrowRight':
              go(1);
              return true;
            case 'Enter':
              if (isLast()) finish();
              else go(1);
              return true;
            case 'ArrowLeft':
              go(-1);
              return true;
            case 'SoftLeft':
            case 'Backspace':
              if (page > 0) {
                go(-1);
                return true;
              }
              return false;
            case 'SoftRight':
              if (isLast()) App.util.openUrl(GUIDE_URL);
              else if (opts.firstRun) finish();
              return true;
          }
          return false;
        }
      };
    }
  };
})();
