(function () {
  'use strict';

  /* Contact/group picker for starting a conversation that has no local
     history yet. */

  App.screens.newchat = {
    create: function () {
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'New chat'));
      el.appendChild(hdr);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      var nav = new App.Nav(el, { scrollEl: list });

      function row(name, kind, id) {
        var r = App.util.el('div', 'conv-row');
        r.setAttribute('nav-selectable', 'true');
        r.setAttribute('data-id', kind + ':' + id);
        r.appendChild(App.util.el('div', 'avatar', App.util.initials(name)));
        var main = App.util.el('div', 'conv-main');
        var top = App.util.el('div', 'conv-top');
        top.appendChild(App.util.el('span', 'conv-name', name));
        main.appendChild(top);
        if (kind === 'g') {
          var bottom = App.util.el('div', 'conv-bottom');
          bottom.appendChild(App.util.el('span', 'conv-preview', 'Group'));
          main.appendChild(bottom);
        }
        r.appendChild(main);
        list.appendChild(r);
      }

      function render() {
        list.textContent = '';
        var contacts = App.store.contactsList();
        var groups = App.store.groupsList();
        if (!contacts.length && !groups.length) {
          list.appendChild(App.util.el('div', 'empty',
            'No contacts or groups found.\n' +
            'Try "Refresh contacts & groups" in Settings.'));
          return;
        }
        contacts.forEach(function (c) {
          if (!c.number && !c.uuid) return;
          row(c.name || c.number || c.uuid, 'c', c.id);
        });
        groups.forEach(function (g) {
          row(g.name, 'g', g.internal_id);
        });
        nav.select(0);
      }

      return {
        el: el,
        enter: function () {
          App.softkeys.set('', 'Open', '');
          render();
        },
        onKey: function (evt) {
          if (nav.handleKey(evt)) return true;
          if (evt.key === 'Enter') {
            var sel = nav.selected();
            if (!sel) return true;
            var id = sel.getAttribute('data-id');
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
