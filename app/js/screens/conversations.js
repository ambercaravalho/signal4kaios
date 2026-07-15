(function () {
  'use strict';

  App.screens.conversations = {
    create: function () {
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      var title = App.util.el('span', 'hdr-title', 'Signal');
      // Connection status is a single dot (green online, red offline, pulsing
      // yellow while reconnecting), positioned absolutely so it never shifts
      // the centered title.
      var dot = App.util.el('span', 'conn-dot');
      hdr.appendChild(title);
      hdr.appendChild(dot);
      el.appendChild(hdr);

      // Chats / Archived are two tabs (KaiOS Tab component), switched with the
      // Left/Right D-pad keys, instead of a separate archived screen.
      var tabs = App.tabs.create(['Chats', 'Archived'], function () {
        render();
        nav.select(0);
        updateSoftkeys();
      });
      el.appendChild(tabs.el);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      var nav = new App.Nav(el, { scrollEl: list });

      function archivedTab() { return tabs.index() === 1; }

      function setConn(state) {
        var cls = state === 'open' ? 'on'
          : (state === 'connecting' ? 'connecting' : 'off');
        dot.className = 'conn-dot ' + cls;
        dot.setAttribute('title', state === 'open' ? 'Online'
          : (state === 'connecting' ? 'Reconnecting\u2026' : 'Offline'));
      }

      function convRow(conv) {
        var row = App.util.el('div', 'conv-row');
        row.setAttribute('nav-selectable', 'true');
        row.setAttribute('data-id', conv.id);

        row.appendChild(App.avatars.el(conv));

        var main = App.util.el('div', 'conv-main');
        var top = App.util.el('div', 'conv-top');
        top.appendChild(App.util.el('span', 'conv-name', conv.name || conv.id));
        if (conv.pinned && !archivedTab()) {
          top.appendChild(App.util.el('span', 'pin-icon', '\uD83D\uDCCC'));
        }
        if (conv.muted) top.appendChild(App.util.el('span', 'muted-icon', '\uD83D\uDD07'));
        top.appendChild(App.util.el('span', 'conv-time', App.util.fmtTime(conv.lastTs)));
        main.appendChild(top);

        var bottom = App.util.el('div', 'conv-bottom');
        var typing = !archivedTab() && App.store.typing(conv.id);
        var preview = App.util.el('span',
          'conv-preview' + (typing ? ' typing' : ''),
          typing ? 'typing\u2026' : (conv.lastPreview || ''));
        bottom.appendChild(preview);
        if (conv.unread > 0) {
          bottom.appendChild(App.util.el('span', 'badge', String(conv.unread)));
        }
        main.appendChild(bottom);
        row.appendChild(main);
        return row;
      }

      function updateSoftkeys() {
        if (archivedTab()) {
          var hasArchived = App.store.archivedConversations().length > 0;
          App.softkeys.set('Options', hasArchived ? 'Open' : '', '');
        } else {
          var hasChats = App.store.conversations().length > 0;
          App.softkeys.set('Options', hasChats ? 'Open' : '', 'New chat');
        }
      }

      function render() {
        list.textContent = '';

        if (archivedTab()) {
          var archived = App.store.archivedConversations();
          if (!archived.length) {
            list.appendChild(App.util.el('div', 'empty', 'No archived chats.'));
            updateSoftkeys();
            return;
          }
          archived.forEach(function (conv) { list.appendChild(convRow(conv)); });
          nav.refresh();
          updateSoftkeys();
          return;
        }

        var convs = App.store.conversations();
        if (!convs.length) {
          if (!App.store.isReady()) {
            // Still loading history from IndexedDB: don't flash the empty
            // state before the store has finished its first read.
            list.appendChild(App.util.el('div', 'empty', 'Loading\u2026'));
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
        convs.forEach(function (conv) { list.appendChild(convRow(conv)); });
        nav.refresh();
        updateSoftkeys();
      }

      function selectedConv() {
        var sel = nav.selected();
        return sel ? App.store.conversation(sel.getAttribute('data-id')) : null;
      }

      function openOptionsMenu() {
        var items = [];
        var conv = selectedConv();

        if (archivedTab()) {
          if (!conv) return;
          items.push({
            label: 'Unarchive chat',
            hint: conv.name,
            onSelect: function () {
              App.store.setArchived(conv.id, false);
              App.toast('Unarchived');
            }
          });
          items.push({
            label: conv.muted ? 'Unmute chat' : 'Mute chat',
            onSelect: function () { App.store.setMuted(conv.id, !conv.muted); }
          });
          App.router.push(App.screens.menu.create({ title: conv.name, items: items }));
          return;
        }

        // Chats tab: actions on the highlighted conversation, then app actions.
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
              App.toast('Archived \u2014 new messages bring it back');
            }
          });
          items.push({
            label: conv.muted ? 'Unmute chat' : 'Mute chat',
            hint: conv.muted ? 'Notifications are off' : 'Stop notifications',
            onSelect: function () {
              App.store.setMuted(conv.id, !conv.muted);
            }
          });
          items.push({ section: 'App' });
        }

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
      function onConnection(state) { setConn(state); }

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
          setConn(App.store.connectionState());
          render();
        },
        resume: function () {
          paused = false;
          dirty = false;
          setConn(App.store.connectionState());
          render();
        },
        pause: function () { paused = true; },
        destroy: unsubscribe,
        onKey: function (evt) {
          if (tabs.handleKey(evt)) return true;
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
            case 'SoftRight':
              if (!archivedTab()) App.router.push(App.screens.newchat.create());
              return true;
            default:
              return false;
          }
        }
      };
    }
  };
})();
