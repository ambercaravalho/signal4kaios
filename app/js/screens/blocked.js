(function () {
  'use strict';

  /* Everything currently blocked, from the primary device's blocked sync and Storage Service. Enter unblocks the selected person or group on all your devices; block people from their contact info and groups from Group info. */

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
      var entries = [];

      function infoRow(name, hint, entry) {
        var row = App.util.el('div', 'conv-row');
        row.setAttribute('nav-selectable', 'true');
        row.setAttribute('data-id', String(entries.length));
        entries.push(entry);
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

      function softkeys() {
        App.softkeys.set('Back', entries.length ? 'Unblock' : '', '');
      }

      function render(contacts, groups) {
        list.textContent = '';
        entries = [];
        var people = (contacts || []).filter(function (c) { return c.blocked; });
        var blockedGroups = (groups || []).filter(function (g) { return g.blocked; });

        if (!people.length && !blockedGroups.length) {
          list.appendChild(App.util.el('div', 'empty',
            'No blocked contacts or groups.'));
        } else {
          if (people.length) {
            list.appendChild(App.util.sectionHeader('People'));
            people.forEach(function (c) {
              var name = nameOf(c);
              infoRow(name, c.number || c.uuid || '', { kind: 'contact', id: c.uuid || c.number, name: name });
            });
          }
          if (blockedGroups.length) {
            list.appendChild(App.util.sectionHeader('Groups'));
            blockedGroups.forEach(function (g) {
              infoRow(g.name || 'Group', 'Group', { kind: 'group', id: g.id, name: g.name || 'Group' });
            });
          }
        }

        nav.refresh();
        nav.select(0);
        softkeys();
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

      function unblock(entry) {
        App.dialog.confirm({
          title: 'Unblock ' + entry.name + '?',
          message: entry.kind === 'group'
            ? 'Group members will be able to add you to this group again.'
            : 'They will be able to message and call you again.',
          confirmLabel: 'Unblock',
          onConfirm: function () {
            var call = entry.kind === 'group' ? App.api.unblockGroup(entry.id) : App.api.unblockContact(entry.id);
            call.then(function () {
              App.toast('Unblocked');
              load();
            })['catch'](function (err) {
              App.toast('Unblock failed: ' + err.message);
            });
          }
        });
      }

      return {
        el: el,
        enter: function () {
          softkeys();
          load();
        },
        resume: function () {
          softkeys();
        },
        onKey: function (evt) {
          if (nav.handleKey(evt)) return true;
          if (evt.key === 'Enter') {
            var sel = nav.selected();
            var entry = sel && entries[parseInt(sel.getAttribute('data-id'), 10)];
            if (entry) unblock(entry);
            return true;
          }
          return false;
        }
      };
    }
  };
})();
