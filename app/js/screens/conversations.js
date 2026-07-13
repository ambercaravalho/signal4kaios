(function () {
  'use strict';

  App.screens.conversations = {
    create: function () {
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      var title = App.util.el('span', 'hdr-title', 'Signal');
      var sub = App.util.el('span', 'hdr-sub', '');
      hdr.appendChild(title);
      hdr.appendChild(sub);
      el.appendChild(hdr);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      var nav = new App.Nav(el, { scrollEl: list });

      function connLabel(state) {
        if (state === 'open') return '● online';
        if (state === 'connecting') return 'connecting…';
        return 'offline';
      }

      function archivedRow() {
        var archived = App.store.archivedConversations();
        if (!archived.length) return;
        var totalUnread = 0;
        archived.forEach(function (c) { totalUnread += c.unread || 0; });
        var row = App.util.el('div', 'menu-item archived-row',
          '📁 Archived chats (' + archived.length + ')' +
          (totalUnread ? ' •' : ''));
        row.setAttribute('nav-selectable', 'true');
        row.setAttribute('data-id', '__archived');
        list.appendChild(row);
      }

      function render() {
        list.textContent = '';
        var convs = App.store.conversations();
        if (!convs.length) {
          if (App.store.archivedConversations().length) {
            archivedRow();
            nav.refresh();
            App.softkeys.set('Options', 'Open', 'New chat');
            return;
          }
          // Still loading history from IndexedDB: don't flash the empty
          // state before the store has finished its first read.
          if (!App.store.isReady()) {
            list.appendChild(App.util.el('div', 'empty', 'Loading…'));
            App.softkeys.set('Options', '', 'New chat');
            return;
          }
          list.appendChild(App.util.el('div', 'empty',
            'No conversations yet.\n' +
            'Message history builds up as messages arrive.\n' +
            'Press the right softkey to start a new chat.'));
          App.softkeys.set('Options', '', 'New chat');
          return;
        }
        convs.forEach(function (conv) {
          var row = App.util.el('div', 'conv-row');
          row.setAttribute('nav-selectable', 'true');
          row.setAttribute('data-id', conv.id);

          row.appendChild(App.avatars.el(conv));

          var main = App.util.el('div', 'conv-main');
          var top = App.util.el('div', 'conv-top');
          top.appendChild(App.util.el('span', 'conv-name', conv.name || conv.id));
          if (conv.pinned) top.appendChild(App.util.el('span', 'pin-icon', '📌'));
          if (conv.muted) top.appendChild(App.util.el('span', 'muted-icon', '🔇'));
          top.appendChild(App.util.el('span', 'conv-time', App.util.fmtTime(conv.lastTs)));
          main.appendChild(top);

          var bottom = App.util.el('div', 'conv-bottom');
          var typing = App.store.typing(conv.id);
          var preview = App.util.el('span',
            'conv-preview' + (typing ? ' typing' : ''),
            typing ? 'typing…' : (conv.lastPreview || ''));
          bottom.appendChild(preview);
          if (conv.unread > 0) {
            bottom.appendChild(App.util.el('span', 'badge', String(conv.unread)));
          }
          main.appendChild(bottom);
          row.appendChild(main);
          list.appendChild(row);
        });
        archivedRow();
        nav.refresh();
        App.softkeys.set('Options', 'Open', 'New chat');
      }

      function openOptionsMenu() {
        var items = [];

        // Actions on the currently highlighted conversation.
        var sel = nav.selected();
        var convId = sel && sel.getAttribute('data-id');
        var conv = convId && convId !== '__archived'
          ? App.store.conversation(convId) : null;
        if (conv) {
          items.push({ section: 'This chat' });
          items.push({
            label: conv.type === 'group' ? 'Group info' : 'Contact info',
            hint: conv.name,
            onSelect: function () {
              if (conv.type === 'group') {
                App.router.replace(App.screens.groupinfo.create(conv));
              } else {
                App.router.replace(App.screens.contactinfo.create(conv));
              }
              return 'keep'; // replace() already removed this menu
            }
          });
          items.push({
            label: conv.pinned ? 'Unpin chat' : 'Pin chat',
            hint: conv.pinned ? 'Remove from top' : 'Keep at the top',
            onSelect: function () {
              App.store.setConvPinned(conv.id, !conv.pinned);
            }
          });
          items.push({
            label: 'Archive chat',
            hint: conv.name,
            onSelect: function () {
              App.store.setArchived(conv.id, true);
              App.toast('Archived — new messages bring it back');
            }
          });
          items.push({
            label: conv.muted ? 'Unmute chat' : 'Mute chat',
            hint: conv.muted ? 'Notifications are off' : 'Stop notifications',
            onSelect: function () {
              App.store.setMuted(conv.id, !conv.muted);
            }
          });
        }

        if (conv) items.push({ section: 'App' });
        items.push({
          label: 'Search messages',
          onSelect: function () {
            App.router.replace(App.screens.search.create());
            return 'keep'; // replace() already removed this menu
          }
        });
        items.push({
          label: 'Settings',
          onSelect: function () {
            App.router.replace(App.screens.settings.create());
            return 'keep';
          }
        });

        App.router.push(App.screens.menu.create({ title: 'Options', items: items }));
      }

      var paused = false;
      var dirty = false;

      function renderIfVisible() {
        if (paused) {
          dirty = true;
          return;
        }
        render();
      }

      function onConvsChanged() { renderIfVisible(); }
      function onTyping() { renderIfVisible(); }
      function onConnection(state) { sub.textContent = connLabel(state); }

      function subscribe() {
        App.store.on('conversations', onConvsChanged);
        App.store.on('typing', onTyping);
        App.store.on('connection', onConnection);
      }

      function unsubscribe() {
        App.store.off('conversations', onConvsChanged);
        App.store.off('typing', onTyping);
        App.store.off('connection', onConnection);
      }

      return {
        el: el,
        enter: function () {
          subscribe();
          paused = false;
          sub.textContent = connLabel(App.store.connectionState());
          render();
        },
        resume: function () {
          paused = false;
          dirty = false;
          sub.textContent = connLabel(App.store.connectionState());
          render();
        },
        pause: function () { paused = true; },
        destroy: unsubscribe,
        onKey: function (evt) {
          if (nav.handleKey(evt)) return true;
          switch (evt.key) {
            case 'Enter': {
              var sel = nav.selected();
              if (!sel) return true;
              var id = sel.getAttribute('data-id');
              if (id === '__archived') {
                App.router.push(App.screens.archived.create());
              } else {
                App.router.push(App.screens.chat.create(id));
              }
              return true;
            }
            case 'SoftLeft':
              openOptionsMenu();
              return true;
            case 'SoftRight':
              App.router.push(App.screens.newchat.create());
              return true;
            default:
              return false;
          }
        }
      };
    }
  };
})();
