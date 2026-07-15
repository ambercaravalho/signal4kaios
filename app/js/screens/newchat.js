(function () {
  'use strict';

  /* Contact/group picker for starting a conversation that has no local
     history yet. A query field filters the directory client-side and also
     lets you start a chat with a typed number or username. */

  function normalizeNumber(v) {
    var n = v.replace(/[\s()-]/g, '');
    if (n && n.charAt(0) !== '+') n = '+' + n;
    return n;
  }

  function looksLikeNumber(v) {
    return /^\+?[\d\s()-]{6,20}$/.test(v);
  }

  App.screens.newchat = {
    create: function () {
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'New chat'));
      el.appendChild(hdr);

      var field = App.util.el('div', 'field');
      var input = App.util.el('input');
      input.type = 'text';
      input.placeholder = 'Search or type a number…';
      input.setAttribute('nav-selectable', 'true');
      input.setAttribute('data-id', '__query');
      field.appendChild(input);
      el.appendChild(field);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      var nav = new App.Nav(el, { scrollEl: list });
      var busy = false;

      function row(name, hint, kind, id, avatarConv) {
        var r = App.util.el('div', 'conv-row');
        r.setAttribute('nav-selectable', 'true');
        r.setAttribute('data-id', kind + ':' + id);
        var avatarEl = App.util.el('div',
          'avatar ' + App.util.colorClass(name), App.util.initials(name));
        r.appendChild(avatarEl);
        if (avatarConv) App.avatars.apply(avatarEl, avatarConv);
        var main = App.util.el('div', 'conv-main');
        var top = App.util.el('div', 'conv-top');
        top.appendChild(App.util.el('span', 'conv-name', name));
        main.appendChild(top);
        if (hint) {
          var bottom = App.util.el('div', 'conv-bottom');
          bottom.appendChild(App.util.el('span', 'conv-preview', hint));
          main.appendChild(bottom);
        }
        r.appendChild(main);
        list.appendChild(r);
      }

      function matches(hay, q) {
        return hay && hay.toLowerCase().indexOf(q) !== -1;
      }

      function render() {
        var q = input.value.replace(/^\s+|\s+$/g, '').toLowerCase();
        list.textContent = '';

        var contacts = App.store.contactsList();
        var groups = App.store.groupsList();
        var shown = 0;

        contacts.forEach(function (c) {
          if (!c.number && !c.uuid) return;
          var name = c.name || c.number || c.uuid;
          if (q && !matches(name, q) && !matches(c.number, q)) return;
          var hint = c.number && c.number !== name ? c.number : '';
          row(name, hint, 'c', c.id, { id: c.number || c.uuid, type: 'direct' });
          shown += 1;
        });
        groups.forEach(function (g) {
          if (q && !matches(g.name, q)) return;
          row(g.name, 'Group', 'g', g.internal_id,
            { id: 'g:' + g.internal_id, type: 'group', sendId: g.id });
          shown += 1;
        });

        // Offer to start a chat with whatever was typed.
        if (q) {
          var raw = input.value.replace(/^\s+|\s+$/g, '');
          var r = App.util.el('div', 'conv-row');
          r.setAttribute('nav-selectable', 'true');
          r.setAttribute('data-id', '__new');
          var main = App.util.el('div', 'conv-main');
          main.appendChild(App.util.el('span', 'conv-name',
            'Start chat with "' + raw + '"'));
          r.appendChild(main);
          list.appendChild(r);
        } else if (!shown) {
          list.appendChild(App.util.el('div', 'empty',
            'No contacts or groups found.\n' +
            'Try "Refresh contacts & groups" in Settings.'));
        }

        nav.refresh();
      }

      function startTyped() {
        if (busy) return;
        var raw = input.value.replace(/^\s+|\s+$/g, '');
        if (!raw) return;

        if (looksLikeNumber(raw)) {
          var n = normalizeNumber(raw);
          busy = true;
          App.toast('Checking…');
          App.api.searchNumbers(n).then(function (res) {
            busy = false;
            var entry = res && res.length ? res[0] : null;
            if (entry && entry.registered) {
              openDirect(n);
            } else {
              App.toast('Not registered on Signal');
            }
          })['catch'](function (e) {
            busy = false;
            App.util.dbg('search failed ' + e.message);
            App.toast('Could not verify number');
          });
        } else {
          // Treat as a Signal username; the server resolves it on send.
          openDirect(raw);
        }
      }

      function openDirect(recipient) {
        var conv = App.store.openConversationWith({ number: recipient });
        App.router.replace(App.screens.chat.create(conv.id));
      }

      /* Scanned QR data is usually a signal.me / username link we can't resolve
         to a recipient, so pull out a phone number if present and otherwise
         drop the raw text into the field for the user to review. */
      function onScan(text) {
        if (!text) return;
        var m = String(text).match(/\+?\d[\d\s()-]{5,}/);
        input.value = m ? m[0] : text;
        render();
        nav.selectById('__query');
        App.toast('Scanned — press Open to start');
      }

      function openScan() {
        App.router.push(App.screens.scanqr.create(onScan));
      }

      return {
        el: el,
        enter: function () {
          App.softkeys.set('Back', 'Open', 'Scan');
          render();
          nav.selectById('__query');
        },
        resume: function () {
          App.softkeys.set('Back', 'Open', 'Scan');
          render();
        },
        onKey: function (evt) {
          if (evt.key === 'SoftRight') { openScan(); return true; }
          var inInput = document.activeElement === input;
          if (inInput && (evt.key === 'ArrowLeft' || evt.key === 'ArrowRight')) {
            return false; // move the text cursor
          }
          // Live-filter as the user types printable keys / deletes.
          if (inInput && evt.key !== 'Enter' && evt.key !== 'ArrowDown' &&
              evt.key !== 'ArrowUp') {
            setTimeout(render, 0);
            return false;
          }
          if (nav.handleKey(evt)) return true;
          if (evt.key === 'Enter') {
            var sel = nav.selected();
            if (!sel) return true;
            var id = sel.getAttribute('data-id');
            if (id === '__query') {
              startTyped();
              return true;
            }
            if (id === '__new') {
              startTyped();
              return true;
            }
            var kind = id.slice(0, 1);
            var key = id.slice(2);
            var conv;
            if (kind === 'g') {
              conv = App.store.openGroupConversation(key);
            } else {
              var contact = null;
              App.store.contactsList().forEach(function (c) {
                if (c.id === key) contact = c;
              });
              if (!contact) return true;
              conv = App.store.openConversationWith(contact);
            }
            App.router.replace(App.screens.chat.create(conv.id));
            return true;
          }
          return false;
        }
      };
    }
  };
})();
