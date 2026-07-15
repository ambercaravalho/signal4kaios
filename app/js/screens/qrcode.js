(function () {
  'use strict';

  /* Render a Signal username link as a QR code using the vendored ES5
     qrcode-generator (global `qrcode`). create(link). */

  App.screens.qrcode = {
    create: function (link) {
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'My QR code'));
      el.appendChild(hdr);

      var box = App.util.el('div', 'viewer qr-box');
      el.appendChild(box);

      function render() {
        box.textContent = '';
        if (typeof qrcode === 'undefined') {
          box.appendChild(App.util.el('div', 'viewer-status',
            'QR generator unavailable.'));
          return;
        }
        if (!link) {
          box.appendChild(App.util.el('div', 'viewer-status',
            'No link to show yet.'));
          return;
        }
        try {
          var qr = qrcode(0, 'L');
          qr.addData(link);
          qr.make();
          var img = App.util.el('img', 'qr-img');
          img.src = qr.createDataURL(5, 4);
          box.appendChild(img);
        } catch (e) {
          App.util.dbg('qr render failed: ' + e.message);
          box.appendChild(App.util.el('div', 'viewer-status',
            'Could not render QR code.'));
        }
        var caption = App.util.el('div', 'qr-caption');
        App.util.linkify(caption, link);
        box.appendChild(caption);
      }

      return {
        el: el,
        enter: function () {
          App.softkeys.set({ icon: 'back' }, '', link ? 'Open link' : '');
          render();
        },
        resume: function () {
          App.softkeys.set({ icon: 'back' }, '', link ? 'Open link' : '');
        },
        onKey: function (evt) {
          if (evt.key === 'SoftRight' && link) {
            App.util.openUrl(link);
            return true;
          }
          return false;
        }
      };
    }
  };
})();
