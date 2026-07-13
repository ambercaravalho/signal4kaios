(function () {
  'use strict';

  var PAGE = 50;
  var DOM_CAP = 120; // max message nodes kept in the DOM at once
  var AUTO_DL = 400 * 1024; // auto-download images up to this size for inline view

  var lastDirRefresh = 0; // throttle background refreshes for unknown authors

  /* Best label for a group message author: a saved contact (which already
     resolves nickname -> profile -> username) wins over the sender's own
     profile name, then the raw id. Unknown authors kick off a throttled
     directory refresh so names fill in on later renders. */
  function authorLabel(rec) {
    var contact = App.store.contactByKey(rec.author);
    if (contact && contact.name) return contact.name;
    if (!contact) {
      var now = Date.now();
      if (now - lastDirRefresh > 60000) {
        lastDirRefresh = now;
        App.store.refreshDirectory()['catch'](function () { /* offline is fine */ });
      }
    }
    return rec.authorName || App.store.displayName(rec.author);
  }

  App.screens.chat = {
    create: function (convId, targetTs) {
      var conv = App.store.conversation(convId);
      var msgById = {};
      var oldestTs = 9007199254740991;
      var hasMore = false;
      var pendingQuote = null;
      var editTarget = null;
      var thumbUrls = {}; // attachment id -> object URL (revoked on destroy)
      var lastTypingSent = 0;
      var typingIdleTimer = null;
      var pinnedRecs = []; // pinned messages in this conversation

      var el = App.util.el('div', 'screen');
      el.setAttribute('data-conv-id', convId);
      var hdr = App.util.el('div', 'hdr');
      var title = App.util.el('span', 'hdr-title', conv ? conv.name : convId);
      var sub = App.util.el('span', 'hdr-sub', '');
      hdr.appendChild(title);
      hdr.appendChild(sub);
      el.appendChild(hdr);

      // Tapping this bar lists pinned messages and jumps to one. It only
      // becomes nav-selectable while there is something pinned.
      var pinnedBar = App.util.el('div', 'pinned-bar hidden');
      pinnedBar.setAttribute('data-id', '__pins');
      el.appendChild(pinnedBar);

      var list = App.util.el('div', 'chat-list');
      el.appendChild(list);

      var typingLine = App.util.el('div', 'typing-line hidden');
      el.appendChild(typingLine);

      var composer = App.util.el('div', 'composer');
      var quoteBar = App.util.el('div', 'quote-bar hidden');
      var ta = App.util.el('textarea');
      ta.setAttribute('nav-selectable', 'true');
      ta.setAttribute('data-id', '__composer');
      composer.appendChild(quoteBar);
      composer.appendChild(ta);
      el.appendChild(composer);

      var loadMore = App.util.el('div', 'load-more hidden', 'Load older messages');
      loadMore.setAttribute('data-id', '__more');
      list.appendChild(loadMore);

      var nav = new App.Nav(el, {
        scrollEl: list,
        wrap: false,
        onChange: updateSoftkeys
      });

      function updateSoftkeys() {
        var sel = nav.selected();
        if (sel === ta) {
          var left = editTarget ? 'Cancel edit' : (pendingQuote ? 'Cancel reply' : 'Emoji');
          App.softkeys.set(left, 'Send', editTarget ? '' : 'Attach');
        } else if (sel === loadMore) {
          App.softkeys.set('', 'Load', '');
        } else if (sel === pinnedBar) {
          App.softkeys.set('', 'View pinned', '');
        } else {
          App.softkeys.set('', 'Options', '');
        }
      }

      function ticksFor(rec) {
        switch (rec.status) {
          case 'pending': return { text: '…', cls: 'ticks' };
          case 'sent': return { text: '✓', cls: 'ticks' };
          case 'delivered': return { text: '✓✓', cls: 'ticks' };
          case 'read': return { text: '✓✓', cls: 'ticks read' };
          case 'failed': return { text: '! failed', cls: 'failed' };
          default: return null;
        }
      }

      function reactionSummary(reactions) {
        var counts = {};
        Object.keys(reactions || {}).forEach(function (who) {
          var e = reactions[who];
          counts[e] = (counts[e] || 0) + 1;
        });
        return Object.keys(counts).map(function (e) {
          return counts[e] > 1 ? e + '×' + counts[e] : e;
        }).join(' ');
      }

      function renderMsgNode(rec) {
        var node = App.util.el('div',
          'msg ' + (rec.incoming ? 'in' : 'out') + (rec.deleted ? ' deleted' : ''));
        node.setAttribute('nav-selectable', 'true');
        node.setAttribute('data-id', rec.id);

        if (rec.pinned && !rec.deleted) {
          node.appendChild(App.util.el('div', 'msg-pin', '📌 Pinned'));
        }

        if (rec.incoming && conv && conv.type === 'group') {
          node.appendChild(App.util.el('div', 'msg-author', authorLabel(rec)));
        }

        if (rec.quote && !rec.deleted) {
          var q = App.util.el('div', 'msg-quote');
          q.appendChild(App.util.el('div', 'msg-quote-author',
            App.store.displayName(rec.quote.author)));
          q.appendChild(App.util.el('div', null, (rec.quote.text || '').slice(0, 80)));
          node.appendChild(q);
        }

        if (!rec.deleted && rec.attachments && rec.attachments.length) {
          var att = rec.attachments[0];
          var label = App.store.attachmentLabel(rec.attachments);
          if (att.size) label += ' (' + Math.max(1, Math.round(att.size / 1024)) + ' KB)';
          node.appendChild(App.util.el('div', 'msg-attach', label));
          if ((att.contentType || '').indexOf('image/') === 0 && att.id) {
            node.appendChild(App.util.el('img', 'msg-thumb hidden'));
          }
        }

        var bodyText = rec.deleted ? 'Message deleted' : rec.body;
        if (bodyText) {
          var bodyEl = App.util.el('div', 'msg-body');
          App.util.renderStyledBody(bodyEl, bodyText, rec.deleted ? null : rec.styles);
          node.appendChild(bodyEl);
        }

        var rs = reactionSummary(rec.reactions);
        if (rs) node.appendChild(App.util.el('div', 'msg-reactions', rs));

        var meta = App.util.el('div', 'msg-meta',
          (rec.edited ? '(edited) ' : '') + App.util.fmtMsgTime(rec.timestamp));
        if (!rec.incoming) {
          var t = ticksFor(rec);
          if (t) meta.appendChild(App.util.el('span', t.cls, ' ' + t.text));
        }
        node.appendChild(meta);
        hydrateThumb(node, rec);
        return node;
      }

      /* Show an inline thumbnail: from cache immediately, else auto-download
         small images. Large ones keep the chip (Enter → View photo). */
      function hydrateThumb(node, rec) {
        var att = rec.attachments && rec.attachments[0];
        if (!att || !att.id || rec.deleted) return;
        if ((att.contentType || '').indexOf('image/') !== 0) return;
        var img = node.querySelector('.msg-thumb');
        if (!img) return;

        function show(url) {
          img.src = url;
          img.onload = function () {
            // Keep the view pinned to the bottom while thumbs pop in.
            if (nav.selected() === ta) scrollToBottom();
          };
          img.classList.remove('hidden');
          var chip = node.querySelector('.msg-attach');
          if (chip) chip.classList.add('hidden');
        }

        if (thumbUrls[att.id]) {
          show(thumbUrls[att.id]);
          return;
        }
        App.db.getAttachment(att.id).then(function (row) {
          if (row && row.blob) return row.blob;
          if (att.size && att.size > AUTO_DL) return null;
          return App.api.attachment(att.id).then(function (blob) {
            App.db.putAttachment(att.id, blob, att.contentType).then(function () {
              return App.db.pruneAttachments(40);
            });
            return blob;
          });
        }).then(function (blob) {
          if (!blob) return;
          thumbUrls[att.id] = URL.createObjectURL(blob);
          show(thumbUrls[att.id]);
        })['catch'](function () { /* chip stays; View photo still works */ });
      }

      function scrollToBottom() {
        list.scrollTop = list.scrollHeight;
      }

      function trimDom() {
        var nodes = list.querySelectorAll('.msg');
        var excess = nodes.length - DOM_CAP;
        for (var i = 0; i < excess; i++) {
          delete msgById[nodes[i].getAttribute('data-id')];
          list.removeChild(nodes[i]);
        }
        if (excess > 0) {
          hasMore = true;
          loadMore.classList.remove('hidden');
          var first = list.querySelector('.msg');
          if (first) {
            var firstRec = msgById[first.getAttribute('data-id')];
            if (firstRec) oldestTs = firstRec.timestamp;
          }
        }
      }

      function loadInitial() {
        App.db.getMessagesPage(convId, oldestTs, PAGE).then(function (rows) {
          hasMore = rows.length === PAGE;
          loadMore.classList.toggle('hidden', !hasMore);
          rows.forEach(function (rec) {
            msgById[rec.id] = rec;
            list.appendChild(renderMsgNode(rec));
          });
          if (rows.length) oldestTs = rows[0].timestamp;
          if (targetTs) {
            loadUntilTarget();
          } else {
            nav.selectLast(); // the composer
            scrollToBottom();
          }
          updateSoftkeys();
        });
      }

      /* Page older messages until the target timestamp is on screen, then
         select and scroll to it. Used for "jump to message" from search. */
      function jumpToTarget() {
        var id = null;
        Object.keys(msgById).forEach(function (k) {
          if (msgById[k].timestamp === targetTs) id = k;
        });
        if (!id) return false;
        var node = nodeFor(id);
        if (!node) return false;
        nav.selectById(id);
        try { node.scrollIntoView(); } catch (e) { list.scrollTop = node.offsetTop; }
        return true;
      }

      function loadUntilTarget() {
        if (jumpToTarget()) return;
        if (!hasMore) {
          nav.selectLast();
          scrollToBottom();
          return;
        }
        loadOlder().then(loadUntilTarget);
      }

      function loadOlder() {
        return App.db.getMessagesPage(convId, oldestTs, PAGE).then(function (rows) {
          if (!rows.length) {
            hasMore = false;
            loadMore.classList.add('hidden');
            return;
          }
          var prevHeight = list.scrollHeight;
          var anchor = loadMore.nextSibling;
          rows.forEach(function (rec) {
            msgById[rec.id] = rec;
            list.insertBefore(renderMsgNode(rec), anchor);
          });
          oldestTs = rows[0].timestamp;
          hasMore = rows.length === PAGE;
          loadMore.classList.toggle('hidden', !hasMore);
          list.scrollTop += list.scrollHeight - prevHeight;
        });
      }

      function nodeFor(id) {
        var nodes = list.querySelectorAll('.msg');
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].getAttribute('data-id') === id) return nodes[i];
        }
        return null;
      }

      /* Refresh the "N pinned" bar from the database. The bar is only made
         nav-selectable while it is visible (nav.items() does not skip hidden
         elements). */
      function updatePinnedBar() {
        App.db.getPinned(convId).then(function (rows) {
          pinnedRecs = rows || [];
          if (pinnedRecs.length) {
            pinnedBar.textContent = '📌 ' + pinnedRecs.length +
              (pinnedRecs.length === 1 ? ' pinned message' : ' pinned messages');
            pinnedBar.classList.remove('hidden');
            pinnedBar.setAttribute('nav-selectable', 'true');
          } else {
            pinnedBar.classList.add('hidden');
            pinnedBar.removeAttribute('nav-selectable');
          }
          nav.refresh();
        })['catch'](function () { /* leave the bar as-is */ });
      }

      /* Select a message by timestamp, paging older history if needed. */
      function jumpTo(ts) {
        targetTs = ts;
        loadUntilTarget();
      }

      function openPinnedList() {
        if (!pinnedRecs.length) return;
        var items = pinnedRecs.slice().sort(function (a, b) {
          return b.timestamp - a.timestamp;
        }).map(function (r) {
          var preview = r.body || App.store.attachmentLabel(r.attachments) || 'Message';
          return {
            label: preview.slice(0, 40),
            hint: App.store.displayName(r.author) + ' · ' + App.util.fmtTime(r.timestamp),
            onSelect: function () {
              // Run after this menu pops so the chat is visible for scrolling.
              setTimeout(function () { jumpTo(r.timestamp); }, 0);
            }
          };
        });
        App.router.push(App.screens.menu.create({ title: 'Pinned messages', items: items }));
      }

      /* ---- store listeners ---- */

      function onMessage(rec) {
        if (rec.convId !== convId) return;
        msgById[rec.id] = rec;
        var wasAtComposer = nav.selected() === ta;
        list.appendChild(renderMsgNode(rec));
        trimDom();
        if (wasAtComposer || !rec.incoming) scrollToBottom();
      }

      function onMessageUpdated(rec, oldId) {
        if (rec.convId !== convId) return;
        updatePinnedBar();
        var key = oldId || rec.id;
        var node = nodeFor(key) || nodeFor(rec.id);
        if (!node) return;
        if (oldId && oldId !== rec.id) {
          delete msgById[oldId];
          if (nav.activeId === oldId) nav.activeId = rec.id;
        }
        msgById[rec.id] = rec;
        list.replaceChild(renderMsgNode(rec), node);
        nav.refresh();
      }

      function onMessageRemoved(rec) {
        if (rec.convId !== convId) return;
        var node = nodeFor(rec.id);
        if (node) list.removeChild(node);
        delete msgById[rec.id];
        updatePinnedBar();
      }

      function onTyping(cid) {
        if (cid !== convId) return;
        var t = App.store.typing(convId);
        if (t) {
          typingLine.textContent = (conv && conv.type === 'group'
            ? App.store.displayName(t.author) + ' is typing…'
            : 'typing…');
          typingLine.classList.remove('hidden');
        } else {
          typingLine.classList.add('hidden');
        }
      }

      function onConnection(state) {
        sub.textContent = state === 'open' ? '' : (state === 'connecting' ? 'connecting…' : 'offline');
      }

      /* ---- composing ---- */

      function sendTypingStop() {
        if (typingIdleTimer) {
          clearTimeout(typingIdleTimer);
          typingIdleTimer = null;
        }
        if (lastTypingSent && conv && conv.sendId) {
          lastTypingSent = 0;
          App.api.typingStop(conv.sendId)['catch'](function () { /* best effort */ });
        }
      }

      function onInput() {
        if (!conv || !conv.sendId) return;
        if (!App.config.typingIndicators()) return;
        var now = Date.now();
        if (now - lastTypingSent > 10000) {
          lastTypingSent = now;
          App.api.typingStart(conv.sendId)['catch'](function () { /* best effort */ });
        }
        if (typingIdleTimer) clearTimeout(typingIdleTimer);
        typingIdleTimer = setTimeout(sendTypingStop, 5000);
      }

      function setQuote(q) {
        pendingQuote = q;
        if (q) {
          editTarget = null;
          quoteBar.textContent = 'Reply to ' + App.store.displayName(q.author) +
            ': ' + (q.text || '').slice(0, 40);
          quoteBar.classList.remove('hidden');
        } else {
          quoteBar.textContent = '';
          quoteBar.classList.add('hidden');
        }
        updateSoftkeys();
      }

      function setEditing(rec) {
        editTarget = rec;
        if (rec) {
          pendingQuote = null;
          // Edit the originally typed text (with any style markers), not the
          // stripped display body.
          ta.value = rec.raw != null ? rec.raw : rec.body;
          quoteBar.textContent = 'Editing message';
          quoteBar.classList.remove('hidden');
        } else {
          ta.value = '';
          quoteBar.textContent = '';
          quoteBar.classList.add('hidden');
        }
        updateSoftkeys();
      }

      function send() {
        var text = ta.value.replace(/^\s+|\s+$/g, '');
        if (!text) return;
        sendTypingStop();

        if (editTarget) {
          var target = editTarget;
          setEditing(null);
          App.store.sendEdit(target, text)['catch'](function (err) {
            App.toast('Edit failed: ' + err.message);
          });
          return;
        }

        var quote = pendingQuote;
        ta.value = '';
        setQuote(null);
        App.store.sendText(convId, text, quote)['catch'](function (err) {
          App.toast('Send failed: ' + err.message);
        });
      }

      function currentCaption() {
        var caption = ta.value.replace(/^\s+|\s+$/g, '');
        ta.value = '';
        return caption;
      }

      /* Embed a filename in a data URI so signal-cli keeps it (the format the
         REST API documents: data:<mime>;filename=<name>;base64,<data>). */
      function withFilename(dataUri, name) {
        if (!name) return dataUri;
        var safe = String(name).replace(/[;,]/g, '_');
        return dataUri.replace(/^data:([^;,]*);base64,/,
          'data:$1;filename=' + safe + ';base64,');
      }

      /* The OS file picker on real hardware already offers Camera, Recorder,
         Gallery, Video, etc., so a single "attach a file" path covers photos and
         voice notes without our own sub-menu. */
      function attach() {
        var input = document.createElement('input');
        input.type = 'file';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', function () {
          var file = input.files && input.files[0];
          if (input.parentNode) input.parentNode.removeChild(input);
          if (!file) return;
          App.toast('Preparing file…');
          var caption = currentCaption();
          var reader = new FileReader();
          reader.onload = function () {
            var type = file.type || 'application/octet-stream';
            var dataUri = withFilename(reader.result, file.name);
            App.store.sendAttachment(convId, dataUri, caption, {
              contentType: type, filename: file.name, size: file.size
            })['catch'](function (err) {
              App.toast('Send failed: ' + err.message);
            });
          };
          reader.onerror = function () { App.toast('Could not read file'); };
          reader.readAsDataURL(file);
        });
        input.click();
      }

      function insertAtCursor(text) {
        var start = ta.selectionStart;
        var end = ta.selectionEnd;
        if (start == null) { start = ta.value.length; end = start; }
        var v = ta.value;
        ta.value = v.slice(0, start) + text + v.slice(end);
        var pos = start + text.length;
        ta.focus();
        try { ta.selectionStart = ta.selectionEnd = pos; } catch (e) { /* ok */ }
      }

      function openEmoji() {
        App.router.push(App.screens.emojipicker.create(function (emoji) {
          nav.selectLast();
          insertAtCursor(emoji);
        }));
      }

      function openOptions(rec) {
        App.router.push(App.screens.msgopts.create(rec, {
          reply: function (r) {
            setQuote({
              timestamp: r.timestamp,
              author: r.incoming ? r.author : App.store.selfNumber(),
              text: r.body
            });
            nav.selectLast();
          },
          copy: function (r) {
            ta.value = ta.value ? ta.value + ' ' + r.body : r.body;
            nav.selectLast();
          },
          edit: function (r) {
            setEditing(r);
            nav.selectLast();
          }
        }));
      }

      ta.addEventListener('input', onInput);

      return {
        el: el,
        enter: function () {
          App.store.on('message', onMessage);
          App.store.on('message-updated', onMessageUpdated);
          App.store.on('message-removed', onMessageRemoved);
          App.store.on('typing', onTyping);
          App.store.on('connection', onConnection);
          App.store.setOpenConv(convId);
          App.store.markRead(convId);
          onConnection(App.store.connectionState());
          onTyping(convId);
          // Sweep only this conversation's expired messages (indexed, bounded)
          // before rendering, so opening a chat stays fast.
          App.store.purgeExpiredConv(convId).then(loadInitial, loadInitial);
          updatePinnedBar();
        },
        resume: function () {
          App.store.setOpenConv(convId);
          App.store.markRead(convId);
          nav.refresh();
          updateSoftkeys();
        },
        destroy: function () {
          sendTypingStop();
          Object.keys(thumbUrls).forEach(function (k) {
            URL.revokeObjectURL(thumbUrls[k]);
          });
          App.store.setOpenConv(null);
          App.store.off('message', onMessage);
          App.store.off('message-updated', onMessageUpdated);
          App.store.off('message-removed', onMessageRemoved);
          App.store.off('typing', onTyping);
          App.store.off('connection', onConnection);
        },
        onKey: function (evt) {
          var inComposer = document.activeElement === ta;

          if (inComposer) {
            if (evt.key === 'Enter') {
              send();
              return true;
            }
            if (evt.key === 'SoftLeft' && editTarget) {
              setEditing(null);
              return true;
            }
            if (evt.key === 'SoftLeft' && pendingQuote) {
              setQuote(null);
              return true;
            }
            if (evt.key === 'SoftLeft' && !editTarget && !pendingQuote) {
              openEmoji();
              return true;
            }
            if (evt.key === 'SoftRight' && !editTarget) {
              attach();
              return true;
            }
            if (evt.key === 'ArrowUp') {
              if (ta.selectionStart > 0) return false; // move text cursor
              return nav.move(-1);
            }
            // ArrowDown / character keys edit the textarea.
            return false;
          }

          if (nav.handleKey(evt)) return true;

          if (evt.key === 'Enter') {
            var sel = nav.selected();
            if (!sel) return true;
            if (sel === loadMore) {
              loadOlder();
              return true;
            }
            if (sel === pinnedBar) {
              openPinnedList();
              return true;
            }
            var rec = msgById[sel.getAttribute('data-id')];
            if (rec) openOptions(rec);
            return true;
          }
          return false;
        }
      };
    }
  };
})();
