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

      function render() {
        list.textContent = '';
        var convs = App.store.conversations();
        if (!convs.length) {
          list.appendChild(App.util.el('div', 'empty',
            'No conversations yet.\n' +
            'Message history builds up as messages arrive.\n' +
            'Press the right softkey to start a new chat.'));
          App.softkeys.set('Settings', '', 'New chat');
          return;
        }
        convs.forEach(function (conv) {
          var row = App.util.el('div', 'conv-row');
          row.setAttribute('nav-selectable', 'true');
          row.setAttribute('data-id', conv.id);

          row.appendChild(App.util.el('div', 'avatar', App.util.initials(conv.name)));

          var main = App.util.el('div', 'conv-main');
          var top = App.util.el('div', 'conv-top');
          top.appendChild(App.util.el('span', 'conv-name', conv.name || conv.id));
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
        nav.refresh();
        App.softkeys.set('Settings', 'Open', 'New chat');
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
              if (sel) {
                App.router.push(App.screens.chat.create(sel.getAttribute('data-id')));
              }
              return true;
            }
            case 'SoftLeft':
              App.router.push(App.screens.settings.create());
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
