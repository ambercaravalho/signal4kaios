(function () {
  'use strict';

  /* Read-only list of everything currently blocked. The REST API only exposes
     a `blocked` flag on contacts and groups (and a group block endpoint); it
     has no unblock endpoint and no contact block/unblock, so unblocking must be
     done from the Signal app. This screen just surfaces who is blocked. */

  function nameOf(c) {
    var key = c.number || c.uuid;
    if (key && App.store.displayName(key) !== key) return App.store.displayName(key);
    return c.name || c.profile_name || c.number || c.uuid || 'Unknown';
  }

  App.screens.blocked = {
    create: function () {
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'Blocked'));
      el.appendChild(hdr);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      var nav = new App.Nav(el, { scrollEl: list });

      function infoRow(name, hint) {
        var row = App.util.el('div', 'conv-row');
        row.setAttribute('nav-selectable', 'true');
        row.setAttribute('data-id', 'x');
        var avatarEl = App.util.el('div',
          'avatar ' + App.util.colorClass(name), App.util.initials(name));
        row.appendChild(avatarEl);
        var main = App.util.el('div', 'conv-main');
        var top = App.util.el('div', 'conv-top');
        top.appendChild(App.util.el('span', 'conv-name', name));
        main.appendChild(top);
        if (hint) {
          var bottom = App.util.el('div', 'conv-bottom');
          bottom.appendChild(App.util.el('span', 'conv-preview', hint));
          main.appendChild(bottom);
        }
        row.appendChild(main);
        list.appendChild(row);
      }

      function render(contacts, groups) {
        list.textContent = '';
        var people = (contacts || []).filter(function (c) { return c.blocked; });
        var blockedGroups = (groups || []).filter(function (g) { return g.blocked; });

        if (!people.length && !blockedGroups.length) {
          list.appendChild(App.util.el('div', 'empty',
            'No blocked contacts or groups.'));
        } else {
          if (people.length) {
            list.appendChild(App.util.sectionHeader('People'));
            people.forEach(function (c) {
              infoRow(nameOf(c), c.number || c.uuid || '');
            });
          }
          if (blockedGroups.length) {
            list.appendChild(App.util.sectionHeader('Groups'));
            blockedGroups.forEach(function (g) {
              infoRow(g.name || 'Group', 'Group');
            });
          }
        }

        list.appendChild(App.util.el('div', 'field-note',
          'Blocking a person, and unblocking anyone, is done in the Signal app; ' +
          'this list is read-only. You can block a group from its Group info.'));
        nav.refresh();
        nav.select(0);
        App.softkeys.set('Back', '', '');
      }

      function load() {
        list.textContent = '';
        list.appendChild(App.util.el('div', 'empty', 'Loading…'));
        Promise.all([
          App.api.contacts()['catch'](function () { return []; }),
          App.api.groups()['catch'](function () { return []; })
        ]).then(function (res) {
          render(res[0] || [], res[1] || []);
        })['catch'](function (err) {
          list.textContent = '';
          list.appendChild(App.util.el('div', 'empty',
            'Could not load: ' + err.message));
        });
      }

      return {
        el: el,
        enter: function () {
          App.softkeys.set('Back', '', '');
          load();
        },
        resume: function () {
          App.softkeys.set('Back', '', '');
        },
        onKey: function (evt) {
          if (nav.handleKey(evt)) return true;
          return false;
        }
      };
    }
  };
})();
