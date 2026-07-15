(function () {
  'use strict';

  App.screens.debuglog = {
    create: function () {
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'Debug log'));
      el.appendChild(hdr);

      var pre = App.util.el('div', 'debug-lines');
      el.appendChild(pre);

      function render() {
        var lines = App.util.dbgLines();
        pre.textContent = lines.length ? lines.join('\n') : '(empty)';
        pre.scrollTop = pre.scrollHeight;
      }

      return {
        el: el,
        enter: function () {
          App.softkeys.set({ icon: 'back' }, '', 'Refresh');
          render();
        },
        onKey: function (evt) {
          switch (evt.key) {
            case 'SoftRight':
              render();
              return true;
            case 'ArrowUp':
              pre.scrollTop -= 40;
              return true;
            case 'ArrowDown':
              pre.scrollTop += 40;
              return true;
            default:
              return false;
          }
        }
      };
    }
  };
})();
