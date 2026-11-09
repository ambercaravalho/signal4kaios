(function () {
  'use strict';

  /* Safety numbers (`App.screens.safety`):
     Lists known identities from `App.api.identities()` (computed on-device via 5200 iterations of SHA-512),
     formats the 60-digit safety number in 12 blocks of 5 digits, displays the scannable `CombinedFingerprints`
     QR code, verifies a peer's QR code via the camera (`App.screens.scanqr`), and syncs verification status
     to other linked devices via `SyncMessage.Verified`.
     create({ number?, uuid? }) — when a number or uuid is given, filters to that contact's identity. */

  function formatSafetyNumber(sn) {
    if (!sn) return '';
    var clean = String(sn).replace(/\s+/g, '');
    var chunks = [];
    for (var i = 0; i < clean.length; i += 5) {
      chunks.push(clean.slice(i, i + 5));
    }
    return chunks.join(' ');
  }

  function statusLabel(trustLevel) {
    if (trustLevel === 'TRUSTED_VERIFIED') return '✓ Verified';
    if (trustLevel === 'UNTRUSTED') return '! Changed';
    return 'Unverified';
  }

  App.screens.safety = {
    create: function (opts) {
      opts = opts || {};
      var filterTarget = opts.number || opts.uuid || '';
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'Safety numbers'));
      el.appendChild(hdr);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      var nav = new App.Nav(el, { scrollEl: list });
      var rows = [];

      function labelFor(entry) {
        var key = entry.number || entry.uuid;
        var name = App.store.displayName(key);
        return name && name !== key ? name : (key || '?');
      }

      function render() {
        list.textContent = '';
        if (!rows.length) {
          list.appendChild(App.util.el('div', 'empty',
            'No identity keys recorded yet.\nSend or receive a message first.'));
          nav.refresh();
          return;
        }
        rows.forEach(function (entry, i) {
          var row = App.util.el('div', 'conv-row');
          row.setAttribute('nav-selectable', 'true');
          row.setAttribute('data-id', String(i));
          var main = App.util.el('div', 'conv-main');
          var top = App.util.el('div', 'conv-top');
          top.appendChild(App.util.el('span', 'conv-name', labelFor(entry)));
          top.appendChild(App.util.el('span', 'conv-time',
            statusLabel(entry.trust_level || entry.status)));
          main.appendChild(top);
          var sn = formatSafetyNumber(entry.safety_number || entry.fingerprint || '');
          if (sn) {
            var bottom = App.util.el('div', 'conv-bottom');
            bottom.appendChild(App.util.el('span', 'conv-preview', sn));
            main.appendChild(bottom);
          }
          row.appendChild(main);
          list.appendChild(row);
        });
        nav.refresh();
      }

      function load() {
        list.textContent = '';
        list.appendChild(App.util.el('div', 'empty', 'Loading…'));
        App.api.identities().then(function (res) {
          var all = res || [];
          rows = filterTarget
            ? all.filter(function (e) {
                return e.number === filterTarget || e.uuid === filterTarget;
              })
            : all;
          render();
          if (rows.length) nav.selectById('0');
        })['catch'](function (err) {
          list.textContent = '';
          list.appendChild(App.util.el('div', 'empty', err.message || 'Failed to load'));
        });
      }

      function markVerified(entry, verifiedSn) {
        var target = entry.uuid || entry.number;
        App.api.trustIdentity(target, {
          verified_safety_number: verifiedSn || entry.safety_number,
          trust_all_known_keys: true
        }).then(function () {
          App.toast('Safety number verified');
          load();
        })['catch'](function (err) {
          App.toast('Trust failed: ' + err.message);
        });
      }

      function scanVerify(entry) {
        App.router.push(App.screens.scanqr.create(function (scannedText) {
          if (!scannedText) return;
          if (App.signal && App.signal.verifySafetyNumberQr) {
            var matches = App.signal.verifySafetyNumberQr(
              scannedText,
              entry.scannable_safety_number,
              entry.safety_number
            );
            if (matches) {
              markVerified(entry, entry.safety_number);
            } else {
              App.toast('Warning: QR code does not match!');
            }
          }
        }));
      }

      function openActions(entry) {
        var items = [
          {
            label: 'Mark verified',
            hint: formatSafetyNumber(entry.safety_number).slice(0, 35) + '…',
            onSelect: function () {
              markVerified(entry, entry.safety_number);
            }
          }
        ];
        if (entry.scannable_safety_number) {
          items.push({
            label: 'Show safety QR code',
            hint: 'Let your contact scan to verify',
            onSelect: function () {
              App.router.push(App.screens.qrcode.create(entry.scannable_safety_number));
              return 'keep';
            }
          });
          items.push({
            label: 'Scan contact QR code',
            hint: 'Verify with camera',
            onSelect: function () {
              scanVerify(entry);
              return 'keep';
            }
          });
        }
        App.router.push(App.screens.menu.create({
          title: labelFor(entry),
          items: items
        }));
      }

      return {
        el: el,
        enter: function () {
          App.softkeys.set('Back', 'Select', '');
          load();
        },
        resume: function () {
          App.softkeys.set('Back', 'Select', '');
        },
        onKey: function (evt) {
          if (nav.handleKey(evt)) return true;
          if (evt.key === 'Enter') {
            var sel = nav.selected();
            if (!sel) return true;
            var entry = rows[parseInt(sel.getAttribute('data-id'), 10)];
            if (entry) openActions(entry);
            return true;
          }
          return false;
        }
      };
    }
  };
})();
