(function () {
  'use strict';

  /* Shown instead of the normal UI when the libsignal WebAssembly module cannot start. All Signal encryption runs in that module, so nothing else can work. The usual cause on KaiOS 4.0 is the system CSP for privileged apps lacking 'wasm-unsafe-eval'; docs/setup.md explains the root-only fix. */

  var GUIDE_URL = 'https://github.com/ambercaravalho/signal4kaios/blob/main/docs/setup.md#kaios-40-enable-webassembly';

  function reasonLines(reason) {
    if (reason === 'blocked') {
      return [
        'This phone refused to run the Signal encryption module (WebAssembly).',
        "On KaiOS 4.0 the system security policy for privileged apps must allow 'wasm-unsafe-eval'. This needs the same root access used to install the app.",
        'Follow "KaiOS 4.0: enable WebAssembly" in the setup guide, reboot, and open the app again.'
      ];
    }
    if (reason === 'no-webassembly') {
      return [
        'This browser engine has no WebAssembly support, which the Signal encryption module needs.',
        'Signal4KaiOS requires KaiOS 3.0, 3.1, or 4.0.'
      ];
    }
    return [
      'The Signal encryption module (vendor/libsignal_wasm_bg.wasm) is missing or unreadable.',
      'Reinstall the app from the release ZIP.'
    ];
  }

  App.screens.wasmerror = {
    create: function (err) {
      var reason = (err && err.reason) || 'fetch';
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'Cannot start'));
      el.appendChild(hdr);

      var body = App.util.el('div', 'list welcome');
      reasonLines(reason).forEach(function (text) {
        body.appendChild(App.util.el('p', 'welcome-text', text));
      });
      body.appendChild(App.util.el('div', 'welcome-url', GUIDE_URL));
      el.appendChild(body);

      function setSoftkeys() {
        App.softkeys.set('', 'Retry', 'Open guide');
      }

      return {
        el: el,
        enter: setSoftkeys,
        resume: setSoftkeys,
        onKey: function (evt) {
          switch (evt.key) {
            case 'ArrowDown':
              body.scrollTop += 40;
              return true;
            case 'ArrowUp':
              body.scrollTop -= 40;
              return true;
            case 'Enter':
              location.reload();
              return true;
            case 'SoftRight':
              App.util.openUrl(GUIDE_URL);
              return true;
          }
          return false;
        }
      };
    }
  };
})();
