(function () {
  'use strict';

  /* Group info & management. Reads members/description/admins/permissions from
     GET /v1/groups/{number}/{groupid} and offers rename, description,
     disappearing-message timer, member & admin management, permissions,
     group-link control, block and leave. create(conv) */

  function permLabel(perms, key) {
    var v = perms && perms[key];
    if (v === 'only-admins') return 'Only admins';
    if (v === 'every-member') return 'Everyone';
    return '';
  }

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

      /* Re-fetch group detail then re-render the main screen. */
      function reloadDetail() {
        return App.api.groupDetail(groupId).then(function (res) {
          if (res) detail = res;
          render();
        })['catch'](function (err) {
          App.util.dbg('group detail reload failed ' + err.message);
        });
      }

      /* Start a 1:1 chat with a member. Member ids are either an E.164 number
         or a UUID; route each to the right field so the conversation key is
         consistent with the rest of the app. */
      function messageMember(entry) {
        var contact = entry.id.charAt(0) === '+'
          ? { number: entry.id, name: entry.name }
          : { uuid: entry.id, name: entry.name };
        var c = App.store.openConversationWith(contact);
        App.router.push(App.screens.chat.create(c.id));
      }

      function memberEntries() {
        var me = App.config.number();
        var admins = (detail && detail.admins) || [];
        return ((detail && detail.members) || []).map(function (id) {
          return {
            id: id,
            name: App.store.displayName(id),
            self: id === me,
            admin: admins.indexOf(id) >= 0
          };
        }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      }

      /* Members can number in the hundreds, so they get their own scrollable
         screen. Enter opens per-member actions; SoftLeft adds a member. */
      function membersScreen() {
        var mel = App.util.el('div', 'screen');
        var mhdr = App.util.el('div', 'hdr');
        var mtitle = App.util.el('span', 'hdr-title', 'Members');
        mhdr.appendChild(mtitle);
        mel.appendChild(mhdr);
        var mlist = App.util.el('div', 'list');
        mel.appendChild(mlist);
        var mnav = new App.Nav(mel, { scrollEl: mlist });
        var entries = [];

        function build() {
          entries = memberEntries();
          mtitle.textContent = 'Members (' + entries.length + ')';
          mlist.textContent = '';
          if (!entries.length) {
            mlist.appendChild(App.util.el('div', 'empty', 'No members.'));
          } else {
            entries.forEach(function (entry, i) {
              var row = App.util.el('div', 'conv-row');
              row.setAttribute('nav-selectable', 'true');
              row.setAttribute('data-id', String(i));
              var avatarEl = App.util.el('div',
                'avatar ' + App.util.colorClass(entry.name),
                App.util.initials(entry.name));
              App.avatars.apply(avatarEl, { id: entry.id, type: 'direct' });
              row.appendChild(avatarEl);
              var main = App.util.el('div', 'conv-main');
              var top = App.util.el('div', 'conv-top');
              top.appendChild(App.util.el('span', 'conv-name',
                entry.name + (entry.self ? ' (You)' : '') +
                (entry.admin ? ' · admin' : '')));
              main.appendChild(top);
              row.appendChild(main);
              mlist.appendChild(row);
            });
          }
          mnav.refresh();
        }

        function reload() {
          return App.api.groupDetail(groupId).then(function (res) {
            if (res) detail = res;
            build();
          })['catch'](function () { build(); });
        }

        function act(promise, okMsg) {
          promise.then(function () {
            App.toast(okMsg);
            return reload();
          })['catch'](function (err) {
            App.toast('Failed: ' + (err.message || 'group action'));
          });
        }

        function memberOptions(entry) {
          var items = [];
          if (!entry.self) {
            items.push({
              label: 'Message',
              onSelect: function () { messageMember(entry); }
            });
          }
          if (entry.admin) {
            items.push({
              label: 'Remove admin',
              onSelect: function () {
                act(App.api.removeGroupAdmins(groupId, [entry.id]), 'Removed admin');
              }
            });
          } else {
            items.push({
              label: 'Make admin',
              onSelect: function () {
                act(App.api.addGroupAdmins(groupId, [entry.id]), 'Made admin');
              }
            });
          }
          if (!entry.self) {
            items.push({
              label: 'Remove from group',
              onSelect: function () {
                act(App.api.removeGroupMembers(groupId, [entry.id]),
                  'Removed from group');
              }
            });
          }
          App.router.push(App.screens.menu.create({ title: entry.name, items: items }));
        }

        function addMember() {
          App.router.push(App.screens.textinput.create({
            title: 'Add member',
            label: 'Number or username',
            placeholder: '+15551234567',
            submitLabel: 'Add',
            onSubmit: function (value, done) {
              var v = value.replace(/^\s+|\s+$/g, '');
              if (!v) { done('Enter a number or username'); return 'async'; }
              App.api.addGroupMembers(groupId, [v]).then(function () {
                App.toast('Member added');
                done();
                return reload();
              })['catch'](function (err) {
                done(err.message || 'Add failed');
              });
              return 'async';
            }
          }));
        }

        function softkeys() {
          App.softkeys.set('Add', entries.length ? 'Options' : '', '');
        }

        return {
          el: mel,
          enter: function () { build(); mnav.select(0); softkeys(); },
          resume: function () { softkeys(); },
          onKey: function (evt) {
            if (mnav.handleKey(evt)) { softkeys(); return true; }
            if (evt.key === 'SoftLeft') { addMember(); return true; }
            if (evt.key === 'Enter') {
              var sel = mnav.selected();
              if (!sel) return true;
              var entry = entries[parseInt(sel.getAttribute('data-id'), 10)];
              if (entry) memberOptions(entry);
              return true;
            }
            return false;
          }
        };
      }

      function viewMembers() {
        App.router.push(membersScreen());
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
            var dnote = App.util.el('div', 'field-note');
            dnote.appendChild(document.createTextNode('Description: '));
            App.util.linkify(dnote, detail.description);
            list.appendChild(dnote);
          }
          var count = (detail.members || []).length;
          action('View members', count + (count === 1 ? ' member' : ' members'),
            '__members');
        }

        list.appendChild(App.util.sectionHeader('Manage'));
        action('Rename group', detail ? (detail.name || conv.name) : '', '__rename');
        action('Edit description', '', '__desc');
        action('Disappearing messages',
          App.util.expireLabel(App.store.convExpire(conv.id)), '__expire');

        if (detail) {
          list.appendChild(App.util.sectionHeader('Permissions'));
          action('Who can add members',
            permLabel(detail.permissions, 'add_members'), '__perm_add');
          action('Who can edit group',
            permLabel(detail.permissions, 'edit_group'), '__perm_edit');
          action('Who can send messages',
            permLabel(detail.permissions, 'send_messages'), '__perm_send');
          action('Group link', detail.invite_link ? 'On' : 'Off', '__link');

          list.appendChild(App.util.sectionHeader('Danger zone'));
          action('Block group', 'Stop receiving messages', '__block');
        }
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

      function disappearing() {
        var current = App.store.convExpire(conv.id);
        var items = App.util.EXPIRE_OPTIONS.map(function (opt) {
          return {
            label: opt.label + (opt.secs === current ? '  ✓' : ''),
            onSelect: function () {
              App.api.updateGroup(groupId, { expiration_time: opt.secs })
                .then(function () {
                  App.store.setConvExpire(conv.id, opt.secs);
                  App.toast('Disappearing messages: ' + opt.label);
                })['catch'](function (err) {
                  App.toast('Update failed: ' + err.message);
                });
            }
          };
        });
        App.router.push(App.screens.menu.create({
          title: 'Disappearing messages', items: items
        }));
      }

      /* Change one group permission, sending all three values so the others
         aren't reset to empty by the server. */
      function permMenu(title, key) {
        var perms = (detail && detail.permissions) || {};
        var opts = [
          { v: 'every-member', label: 'Everyone' },
          { v: 'only-admins', label: 'Only admins' }
        ];
        var items = opts.map(function (o) {
          return {
            label: o.label + (perms[key] === o.v ? '  ✓' : ''),
            onSelect: function () {
              var next = {
                add_members: perms.add_members || 'every-member',
                edit_group: perms.edit_group || 'only-admins',
                send_messages: perms.send_messages || 'every-member'
              };
              next[key] = o.v;
              App.api.updateGroup(groupId, { permissions: next }).then(function () {
                App.toast('Permission updated');
                return reloadDetail();
              })['catch'](function (err) {
                App.toast('Update failed: ' + err.message);
              });
            }
          };
        });
        App.router.push(App.screens.menu.create({ title: title, items: items }));
      }

      function groupLinkMenu() {
        var items = [];
        if (detail && detail.invite_link) {
          items.push({
            label: 'Open invite link',
            hint: 'Share this group',
            onSelect: function () { App.util.openUrl(detail.invite_link); }
          });
        }
        [
          { v: 'disabled', label: 'Off' },
          { v: 'enabled', label: 'On' },
          { v: 'enabled-with-approval', label: 'On, admin approval' }
        ].forEach(function (o) {
          items.push({
            label: o.label,
            onSelect: function () {
              App.api.updateGroup(groupId, { group_link: o.v }).then(function () {
                App.toast('Group link: ' + o.label);
                return reloadDetail();
              })['catch'](function (err) {
                App.toast('Update failed: ' + err.message);
              });
            }
          });
        });
        App.router.push(App.screens.menu.create({ title: 'Group link', items: items }));
      }

      function blockGroup() {
        App.router.push(App.screens.menu.create({
          title: 'Block group?',
          items: [{
            label: 'Block group',
            hint: 'Stop receiving messages',
            onSelect: function () {
              App.api.blockGroup(groupId).then(function () {
                App.toast('Group blocked');
                App.store.setArchived(conv.id, true);
              })['catch'](function (err) {
                App.toast('Block failed: ' + err.message);
              });
            }
          }]
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

      function refreshSoftkeys() {
        var sel = nav.selected();
        App.softkeys.set('', sel && sel.__url ? 'Open' : 'Select', '');
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
          if (nav.handleKey(evt)) { refreshSoftkeys(); return true; }
          if (evt.key === 'Enter') {
            var sel = nav.selected();
            if (!sel) return true;
            if (sel.__url) { App.util.openUrl(sel.__url); return true; }
            var id = sel.getAttribute('data-id');
            if (id === '__members') viewMembers();
            else if (id === '__rename') rename();
            else if (id === '__desc') editDescription();
            else if (id === '__expire') disappearing();
            else if (id === '__perm_add') permMenu('Add members', 'add_members');
            else if (id === '__perm_edit') permMenu('Edit group', 'edit_group');
            else if (id === '__perm_send') permMenu('Send messages', 'send_messages');
            else if (id === '__link') groupLinkMenu();
            else if (id === '__block') blockGroup();
            else if (id === '__leave') leave();
            return true;
          }
          return false;
        }
      };
    }
  };
})();
