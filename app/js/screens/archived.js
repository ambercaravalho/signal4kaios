(function () {
  'use strict';

  /* Archived conversations. Archive/mute are local to this device — the
     REST API does not expose Signal's synced chat-list state. A chat leaves
     this list when unarchived here or when any new message arrives in it. */

  App.screens.archived = {
    create: function () {
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'Archived chats'));
      el.appendChild(hdr);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      var nav = new App.Nav(el, { scrollEl: list });
      var paused = false;
      var dirty = false;

      function render() {
        list.textContent = '';
        var convs = App.store.archivedConversations();
        if (!convs.length) {
          list.appendChild(App.util.el('div', 'empty', 'No archived chats.'));
          App.softkeys.set('', '', '');
          return;
        }
        convs.forEach(function (conv) {
          var row = App.util.el('div', 'conv-row');
          row.setAttribute('nav-selectable', 'true');
          row.setAttribute('data-id', conv.id);

          var avatarEl = App.util.el('div',
            'avatar ' + App.util.colorClass(conv.name || conv.id),
            App.util.initials(conv.name));
          row.appendChild(avatarEl);
          App.avatars.apply(avatarEl, conv);

          var main = App.util.el('div', 'conv-main');
          var top = App.util.el('div', 'conv-top');
          top.appendChild(App.util.el('span', 'conv-name', conv.name || conv.id));
          if (conv.muted) top.appendChild(App.util.el('span', 'muted-icon', '🔇'));
          top.appendChild(App.util.el('span', 'conv-time', App.util.fmtTime(conv.lastTs)));
          main.appendChild(top);

          var bottom = App.util.el('div', 'conv-bottom');
          bottom.appendChild(App.util.el('span', 'conv-preview', conv.lastPreview || ''));
          if (conv.unread > 0) {
            bottom.appendChild(App.util.el('span', 'badge', String(conv.unread)));
          }
          main.appendChild(bottom);
          row.appendChild(main);
          list.appendChild(row);
        });
        nav.refresh();
        App.softkeys.set('Options', 'Open', '');
      }

      function renderIfVisible() {
        if (paused) {
          dirty = true;
          return;
        }
        render();
      }

      function selectedConv() {
        var sel = nav.selected();
        return sel ? App.store.conversation(sel.getAttribute('data-id')) : null;
      }

      function openOptionsMenu() {
        var conv = selectedConv();
        if (!conv) return;
        App.router.push(App.screens.menu.create({
          title: conv.name,
          items: [
            {
              label: 'Unarchive chat',
              onSelect: function () { App.store.setArchived(conv.id, false); }
            },
            {
              label: conv.muted ? 'Unmute chat' : 'Mute chat',
              onSelect: function () { App.store.setMuted(conv.id, !conv.muted); }
            }
          ]
        }));
      }

      return {
        el: el,
        enter: function () {
          App.store.on('conversations', renderIfVisible);
          paused = false;
          render();
        },
        resume: function () {
          paused = false;
          dirty = false;
          render();
        },
        pause: function () { paused = true; },
        destroy: function () {
          App.store.off('conversations', renderIfVisible);
        },
        onKey: function (evt) {
          if (nav.handleKey(evt)) return true;
          switch (evt.key) {
            case 'Enter': {
              var conv = selectedConv();
              if (conv) App.router.push(App.screens.chat.create(conv.id));
              return true;
            }
            case 'SoftLeft':
              openOptionsMenu();
              return true;
            default:
              return false;
          }
        }
      };
    }
  };
})();
