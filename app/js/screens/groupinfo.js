(function () {
  'use strict';

  /* Group info & management: shows members/description from GET
     /v1/groups/{number}/{groupid} and offers rename / edit description /
     leave (PUT and the quit endpoint). create(conv) */

  App.screens.groupinfo = {
    create: function (conv) {
      var groupId = conv.sendId;
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'Group info'));
      el.appendChild(hdr);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      var nav = new App.Nav(el, { scrollEl: list });
      var detail = null;

      function memberNames(members) {
        return (members || []).map(function (m) {
          return App.store.displayName(m);
        });
      }

      /* Members can number in the hundreds, so they get their own scrollable
         screen instead of a giant text blob on the info screen. */
      function membersScreen(names) {
        var mel = App.util.el('div', 'screen');
        var mhdr = App.util.el('div', 'hdr');
        mhdr.appendChild(App.util.el('span', 'hdr-title',
          'Members (' + names.length + ')'));
        mel.appendChild(mhdr);
        var mlist = App.util.el('div', 'list');
        mel.appendChild(mlist);
        if (!names.length) {
          mlist.appendChild(App.util.el('div', 'empty', 'No members.'));
        } else {
          names.forEach(function (name, i) {
            var row = App.util.el('div', 'conv-row');
            row.setAttribute('nav-selectable', 'true');
            row.setAttribute('data-id', String(i));
            var main = App.util.el('div', 'conv-main');
            var top = App.util.el('div', 'conv-top');
            top.appendChild(App.util.el('span', 'conv-name', name));
            main.appendChild(top);
            row.appendChild(main);
            mlist.appendChild(row);
          });
        }
        var mnav = new App.Nav(mel, { scrollEl: mlist });
        return {
          el: mel,
          enter: function () {
            App.softkeys.set('', '', '');
            mnav.select(0);
          },
          resume: function () { App.softkeys.set('', '', ''); },
          onKey: function (evt) { return mnav.handleKey(evt); }
        };
      }

      function viewMembers() {
        var names = memberNames(detail && detail.members).sort(function (a, b) {
          return a.localeCompare(b);
        });
        App.router.push(membersScreen(names));
      }

      function action(label, hint, id) {
        var row = App.util.el('div', 'menu-item', label);
        row.setAttribute('nav-selectable', 'true');
        row.setAttribute('data-id', id);
        if (hint) row.appendChild(App.util.el('span', 'hint', hint));
        list.appendChild(row);
      }

      function render() {
        list.textContent = '';

        if (detail) {
          list.appendChild(App.util.sectionHeader('About'));
          list.appendChild(App.util.el('div', 'field-note',
            'Name: ' + (detail.name || conv.name || '(unnamed)')));
          if (detail.description) {
            list.appendChild(App.util.el('div', 'field-note',
              'Description: ' + detail.description));
          }
          var count = (detail.members || []).length;
          action('View members', count + (count === 1 ? ' member' : ' members'),
            '__members');
        }

        list.appendChild(App.util.sectionHeader('Manage'));
        action('Rename group', detail ? (detail.name || conv.name) : '', '__rename');
        action('Edit description', '', '__desc');
        action('Leave group', 'Quit this group', '__leave');

        nav.refresh();
        nav.selectById('__rename');
      }

      function load() {
        list.textContent = '';
        list.appendChild(App.util.el('div', 'empty', 'Loading…'));
        if (!groupId) {
          detail = null;
          render();
          return;
        }
        App.api.groupDetail(groupId).then(function (res) {
          detail = res || null;
          render();
        })['catch'](function (err) {
          App.util.dbg('group detail failed ' + err.message);
          detail = null;
          render();
        });
      }

      function rename() {
        App.router.push(App.screens.textinput.create({
          title: 'Rename group',
          label: 'Group name',
          value: (detail && detail.name) || conv.name || '',
          submitLabel: 'Save',
          onSubmit: function (value, done) {
            if (!value) { done('Name cannot be empty'); return 'async'; }
            App.api.updateGroup(groupId, { name: value }).then(function () {
              App.store.setConversationName(conv.id, value);
              return App.store.refreshDirectory()['catch'](function () {});
            }).then(function () {
              App.toast('Group renamed');
              if (detail) detail.name = value;
              done();
            })['catch'](function (err) {
              done(err.message || 'Rename failed');
            });
            return 'async';
          }
        }));
      }

      function editDescription() {
        App.router.push(App.screens.textinput.create({
          title: 'Description',
          label: 'Group description',
          value: (detail && detail.description) || '',
          submitLabel: 'Save',
          onSubmit: function (value, done) {
            App.api.updateGroup(groupId, { description: value }).then(function () {
              App.toast('Description updated');
              if (detail) detail.description = value;
              done();
            })['catch'](function (err) {
              done(err.message || 'Update failed');
            });
            return 'async';
          }
        }));
      }

      function leave() {
        App.router.push(App.screens.menu.create({
          title: 'Leave group?',
          items: [{
            label: 'Leave group',
            hint: 'You will stop receiving messages',
            onSelect: function () {
              App.api.quitGroup(groupId).then(function () {
                App.toast('Left group');
                App.store.setArchived(conv.id, true);
              })['catch'](function (err) {
                App.toast('Leave failed: ' + err.message);
              });
            }
          }]
        }));
      }

      return {
        el: el,
        enter: function () {
          App.softkeys.set('', 'Select', '');
          load();
        },
        resume: function () {
          App.softkeys.set('', 'Select', '');
        },
        onKey: function (evt) {
          if (nav.handleKey(evt)) return true;
          if (evt.key === 'Enter') {
            var sel = nav.selected();
            if (!sel) return true;
            var id = sel.getAttribute('data-id');
            if (id === '__members') viewMembers();
            else if (id === '__rename') rename();
            else if (id === '__desc') editDescription();
            else if (id === '__leave') leave();
            return true;
          }
          return false;
        }
      };
    }
  };
})();
