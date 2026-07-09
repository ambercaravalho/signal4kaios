(function () {
  'use strict';

  /* Central state + event hub.
     Flow: ws frame -> normalize -> applyEvent -> IndexedDB persist -> emit.
     Screens subscribe to: 'conversations', 'message', 'message-updated',
     'typing', 'connection'. */

  var listeners = {};
  var contactsByKey = {};   // number -> contact AND uuid -> contact
  var groupsByInternal = {}; // internal_id -> { id (send id), name }
  var convs = {};            // convId -> conversation record
  var typingMap = {};        // convId -> { author, until }
  var openConvId = null;
  var connection = 'closed';

  var STATUS_RANK = { pending: 0, failed: 0, sent: 1, delivered: 2, read: 3 };

  function on(evt, fn) {
    (listeners[evt] = listeners[evt] || []).push(fn);
  }

  function off(evt, fn) {
    var arr = listeners[evt] || [];
    var i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }

  function emit(evt, a, b) {
    (listeners[evt] || []).slice().forEach(function (fn) {
      try {
        fn(a, b);
      } catch (e) {
        App.util.dbg('listener error [' + evt + '] ' + e.message);
      }
    });
  }

  function self() {
    return App.config.number();
  }

  function msgId(convId, ts, author) {
    return convId + '|' + ts + '|' + author;
  }

  function contactOf(key) {
    return key ? contactsByKey[key] : null;
  }

  function displayName(key) {
    var c = contactOf(key);
    if (c && c.name) return c.name;
    return key || '?';
  }

  function altKeyOf(key) {
    var c = contactOf(key);
    if (!c) return null;
    if (c.number && c.number !== key) return c.number;
    if (c.uuid && c.uuid !== key) return c.uuid;
    return null;
  }

  function persistConv(conv) {
    return App.db.putConversation(conv);
  }

  function ensureConv(ev) {
    var conv = convs[ev.convId];
    if (conv) return conv;
    if (ev.groupInternalId) {
      var g = groupsByInternal[ev.groupInternalId];
      conv = {
        id: ev.convId,
        type: 'group',
        groupInternalId: ev.groupInternalId,
        sendId: g ? g.id : null,
        name: g ? g.name : 'Group',
        lastTs: 0,
        lastPreview: '',
        unread: 0,
        lastReadTs: 0
      };
      if (!g) refreshDirectory(); // unknown group: refetch in background
    } else {
      var peer = ev.incoming ? ev.author : ev.convId;
      conv = {
        id: ev.convId,
        type: 'direct',
        sendId: ev.convId,
        name: displayName(ev.convId) === ev.convId && ev.incoming && ev.authorName
          ? ev.authorName
          : displayName(ev.convId),
        lastTs: 0,
        lastPreview: '',
        unread: 0,
        lastReadTs: 0
      };
      void peer;
    }
    convs[conv.id] = conv;
    return conv;
  }

  function attachmentLabel(attachments) {
    if (!attachments || !attachments.length) return '';
    var a = attachments[0];
    if ((a.contentType || '').indexOf('image/') === 0) return '📷 Photo';
    return '📎 ' + (a.filename || 'File');
  }

  function previewOf(ev) {
    if (ev.body) return ev.body;
    return attachmentLabel(ev.attachments) || '';
  }

  function notify(conv, rec) {
    if (!document.hidden) return;
    if (typeof Notification === 'undefined') return;
    try {
      var title = conv.name || 'Signal';
      var body = rec.body || '[attachment]';
      if (conv.type === 'group') body = displayName(rec.author) + ': ' + body;
      new Notification(title, { body: body.slice(0, 100), tag: conv.id });
    } catch (e) {
      App.util.dbg('notify failed ' + e.message);
    }
  }

  function applyMessage(ev) {
    var conv = ensureConv(ev);
    var rec = {
      id: msgId(ev.convId, ev.timestamp, ev.author),
      convId: ev.convId,
      incoming: ev.incoming,
      author: ev.author,
      authorName: ev.authorName || '',
      timestamp: ev.timestamp,
      body: ev.body || '',
      quote: ev.quote || null,
      attachments: ev.attachments || [],
      reactions: {},
      status: ev.incoming ? 'received' : 'sent',
      deleted: false,
      edited: false
    };
    App.db.putMessage(rec);

    conv.lastTs = Math.max(conv.lastTs || 0, ev.timestamp);
    conv.lastPreview = previewOf(ev);
    if (ev.incoming && openConvId !== conv.id) conv.unread = (conv.unread || 0) + 1;
    if (typingMap[conv.id]) {
      delete typingMap[conv.id];
      emit('typing', conv.id);
    }
    persistConv(conv);

    emit('message', rec);
    emit('conversations');
    if (ev.incoming) notify(conv, rec);

    // Viewing this chat right now: mark read immediately.
    if (ev.incoming && openConvId === conv.id) {
      markRead(conv.id);
    }
  }

  /* Read-modify-write updates to stored messages must not interleave
     (e.g. a reaction and a read receipt arriving together would clobber
     each other), so they run through one serial queue. */
  var mutations = Promise.resolve();
  function enqueueMutation(fn) {
    mutations = mutations.then(fn)['catch'](function (e) {
      App.util.dbg('mutation failed: ' + e.message);
    });
    return mutations;
  }

  function findMessage(convId, ts, authorCandidates) {
    var ids = [];
    authorCandidates.forEach(function (a) {
      if (a && ids.indexOf(msgId(convId, ts, a)) < 0) ids.push(msgId(convId, ts, a));
    });
    var chain = Promise.resolve(undefined);
    ids.forEach(function (id) {
      chain = chain.then(function (found) {
        if (found) return found;
        return App.db.getMessage(id);
      });
    });
    return chain;
  }

  function applyReaction(ev) {
    var candidates = [ev.targetAuthor, altKeyOf(ev.targetAuthor), self()];
    enqueueMutation(function () {
      return findMessage(ev.convId, ev.targetTimestamp, candidates).then(function (rec) {
        if (!rec) {
          App.util.dbg('reaction target not found', ev);
          return;
        }
        rec.reactions = rec.reactions || {};
        if (ev.remove) delete rec.reactions[ev.reactor];
        else rec.reactions[ev.reactor] = ev.emoji;
        emit('message-updated', rec);
        return App.db.putMessage(rec);
      });
    });
  }

  function applyRemoteDelete(ev) {
    var candidates = [ev.author, altKeyOf(ev.author)];
    enqueueMutation(function () {
      return findMessage(ev.convId, ev.targetTimestamp, candidates).then(function (rec) {
        if (!rec) {
          App.util.dbg('remoteDelete target not found', ev);
          return;
        }
        rec.deleted = true;
        rec.body = '';
        emit('message-updated', rec);
        var conv = convs[ev.convId];
        if (conv && conv.lastTs === rec.timestamp) {
          conv.lastPreview = 'Message deleted';
          persistConv(conv);
          emit('conversations');
        }
        return App.db.putMessage(rec);
      });
    });
  }

  function applyEdit(ev) {
    var candidates = [ev.author, altKeyOf(ev.author), self()];
    enqueueMutation(function () {
      return findMessage(ev.convId, ev.targetTimestamp, candidates).then(function (rec) {
        if (!rec) {
          App.util.dbg('edit target not found', ev);
          return;
        }
        rec.body = ev.newBody;
        rec.edited = true;
        emit('message-updated', rec);
        var conv = convs[ev.convId];
        if (conv && conv.lastTs === rec.timestamp) {
          conv.lastPreview = ev.newBody;
          persistConv(conv);
          emit('conversations');
        }
        return App.db.putMessage(rec);
      });
    });
  }

  function applyTyping(ev) {
    if (!ev.convId) return;
    if (ev.started) {
      typingMap[ev.convId] = { author: ev.author, until: Date.now() + 15000 };
      setTimeout(function () {
        var t = typingMap[ev.convId];
        if (t && t.until <= Date.now()) {
          delete typingMap[ev.convId];
          emit('typing', ev.convId);
        }
      }, 15500);
    } else {
      delete typingMap[ev.convId];
    }
    emit('typing', ev.convId);
  }

  function applyReceipt(ev) {
    if (ev.kind !== 'read' && ev.kind !== 'delivery') return;
    var convId = ev.peer;
    var alt = altKeyOf(ev.peer);
    (ev.timestamps || []).forEach(function (ts) {
      var candidateConvs = [convId, alt];
      // Also check group conversations: receipts for group messages come
      // from individual members but reference our sent timestamp.
      Object.keys(convs).forEach(function (cid) {
        if (convs[cid].type === 'group') candidateConvs.push(cid);
      });
      enqueueMutation(function () {
        var chain = Promise.resolve(undefined);
        candidateConvs.forEach(function (cid) {
          if (!cid) return;
          chain = chain.then(function (found) {
            if (found) return found;
            return App.db.getMessage(msgId(cid, ts, self()));
          });
        });
        return chain.then(function (rec) {
          if (!rec) return;
          var next = ev.kind === 'read' ? 'read' : 'delivered';
          if ((STATUS_RANK[next] || 0) > (STATUS_RANK[rec.status] || 0)) {
            rec.status = next;
            emit('message-updated', rec);
            return App.db.putMessage(rec);
          }
        });
      });
    });
  }

  function applyEvent(ev) {
    switch (ev.type) {
      case 'message': return applyMessage(ev);
      case 'reaction': return applyReaction(ev);
      case 'remoteDelete': return applyRemoteDelete(ev);
      case 'edit': return applyEdit(ev);
      case 'typing': return applyTyping(ev);
      case 'receipt': return applyReceipt(ev);
      default:
        App.util.dbg('unknown event type ' + ev.type);
    }
  }

  function ingestRaw(frame) {
    var events = App.normalize.parse(frame, self());
    events.forEach(applyEvent);
  }

  function refreshDirectory() {
    if (!App.config.isConfigured()) return Promise.resolve();
    return Promise.all([App.api.contacts(), App.api.groups()]).then(function (res) {
      var contacts = res[0] || [];
      var groups = res[1] || [];

      var records = [];
      contacts.forEach(function (c) {
        var rec = {
          id: c.uuid || c.number,
          number: c.number || '',
          uuid: c.uuid || '',
          name: c.name || c.profile_name || c.username || c.number || c.uuid
        };
        if (!rec.id) return;
        records.push(rec);
        if (rec.number) contactsByKey[rec.number] = rec;
        if (rec.uuid) contactsByKey[rec.uuid] = rec;
      });
      App.db.putContacts(records);

      groupsByInternal = {};
      groups.forEach(function (g) {
        if (!g.internal_id) return;
        groupsByInternal[g.internal_id] = { id: g.id, name: g.name || 'Group' };
      });
      App.db.kvSet('groups', groupsByInternal);

      // Refresh names/sendIds on known conversations.
      var changed = false;
      Object.keys(convs).forEach(function (cid) {
        var conv = convs[cid];
        if (conv.type === 'group') {
          var g = groupsByInternal[conv.groupInternalId];
          if (g && (conv.name !== g.name || conv.sendId !== g.id)) {
            conv.name = g.name;
            conv.sendId = g.id;
            persistConv(conv);
            changed = true;
          }
        } else {
          var name = displayName(conv.id);
          if (name !== conv.id && name !== conv.name) {
            conv.name = name;
            persistConv(conv);
            changed = true;
          }
        }
      });
      if (changed) emit('conversations');
      App.util.dbg('directory refreshed: ' + records.length + ' contacts, ' +
        groups.length + ' groups');
      return true;
    });
  }

  /* Shared optimistic-send core: write a pending record, call /v2/send,
     re-key to the server timestamp, mark sent/failed. */
  function sendCore(conv, rec, payload, preview) {
    App.db.putMessage(rec);
    conv.lastTs = rec.timestamp;
    conv.lastPreview = preview;
    persistConv(conv);
    emit('message', rec);
    emit('conversations');

    var ts = rec.timestamp;
    return App.api.send(payload).then(function (res) {
      var newTs = res && res.timestamp ? parseInt(res.timestamp, 10) : ts;
      var oldId = rec.id;
      if (newTs && newTs !== ts) {
        App.db.deleteMessage(oldId);
        rec.timestamp = newTs;
        rec.id = msgId(conv.id, newTs, self());
        conv.lastTs = Math.max(conv.lastTs, newTs);
        persistConv(conv);
      }
      rec.status = 'sent';
      App.db.putMessage(rec);
      emit('message-updated', rec, oldId);
      return rec;
    })['catch'](function (err) {
      rec.status = 'failed';
      App.db.putMessage(rec);
      emit('message-updated', rec);
      App.util.dbg('send failed: ' + err.message);
      throw err;
    });
  }

  function newOutgoingRec(conv, extras) {
    var ts = Date.now();
    return Object.assign({
      id: msgId(conv.id, ts, self()),
      convId: conv.id,
      incoming: false,
      author: self(),
      authorName: '',
      timestamp: ts,
      body: '',
      quote: null,
      attachments: [],
      reactions: {},
      status: 'pending',
      deleted: false,
      edited: false
    }, extras || {});
  }

  function convForSend(convId) {
    var conv = convs[convId];
    if (!conv) throw new Error('Unknown conversation');
    if (!conv.sendId) throw new Error('No send address for this group yet');
    return conv;
  }

  function sendText(convId, text, quote) {
    var conv;
    try { conv = convForSend(convId); } catch (e) { return Promise.reject(e); }

    var rec = newOutgoingRec(conv, { body: text, quote: quote || null });
    var payload = { recipients: [conv.sendId], message: text };
    if (quote) {
      payload.quote_timestamp = quote.timestamp;
      payload.quote_author = quote.author;
      payload.quote_message = quote.text;
    }
    return sendCore(conv, rec, payload, text);
  }

  /* dataUri: "data:image/jpeg;base64,…" (produced by util.scaleImage). */
  function sendAttachment(convId, dataUri, caption) {
    var conv;
    try { conv = convForSend(convId); } catch (e) { return Promise.reject(e); }

    var rec = newOutgoingRec(conv, {
      body: caption || '',
      attachments: [{ id: '', contentType: 'image/jpeg', filename: 'photo.jpg', size: 0 }]
    });
    var payload = {
      recipients: [conv.sendId],
      message: caption || '',
      base64_attachments: [dataUri]
    };
    return sendCore(conv, rec, payload, caption || '📷 Photo');
  }

  /* Edit a previously sent message via /v2/send edit_timestamp. */
  function sendEdit(rec, newText) {
    var conv;
    try { conv = convForSend(rec.convId); } catch (e) { return Promise.reject(e); }

    return App.api.send({
      recipients: [conv.sendId],
      message: newText,
      edit_timestamp: rec.timestamp
    }).then(function () {
      rec.body = newText;
      rec.edited = true;
      App.db.putMessage(rec);
      emit('message-updated', rec);
      if (conv.lastTs === rec.timestamp) {
        conv.lastPreview = newText;
        persistConv(conv);
        emit('conversations');
      }
      return rec;
    });
  }

  function retryMessage(rec) {
    App.db.deleteMessage(rec.id);
    emit('message-removed', rec);
    return sendText(rec.convId, rec.body, rec.quote);
  }

  function reactTo(rec, emoji) {
    var conv = convs[rec.convId];
    if (!conv || !conv.sendId) return Promise.reject(new Error('Cannot react here yet'));
    var me = self();
    var target = rec.incoming ? rec.author : me;
    rec.reactions = rec.reactions || {};
    var prev = rec.reactions[me] || null;
    if (emoji) rec.reactions[me] = emoji;
    else delete rec.reactions[me];
    App.db.putMessage(rec);
    emit('message-updated', rec);
    var call = emoji
      ? App.api.react(conv.sendId, target, rec.timestamp, emoji)
      : App.api.unreact(conv.sendId, target, rec.timestamp, prev || '');
    return call['catch'](function (err) {
      if (prev) rec.reactions[me] = prev;
      else delete rec.reactions[me];
      App.db.putMessage(rec);
      emit('message-updated', rec);
      throw err;
    });
  }

  function deleteForEveryone(rec) {
    var conv = convs[rec.convId];
    if (!conv || !conv.sendId) return Promise.reject(new Error('Cannot delete here'));
    return App.api.remoteDelete(conv.sendId, rec.timestamp).then(function () {
      rec.deleted = true;
      rec.body = '';
      App.db.putMessage(rec);
      emit('message-updated', rec);
    });
  }

  function markRead(convId) {
    var conv = convs[convId];
    if (!conv) return;
    var hadUnread = conv.unread > 0;
    conv.unread = 0;

    // Send read receipts for incoming messages newer than lastReadTs.
    App.db.getMessagesPage(convId, 9007199254740991, 25).then(function (rows) {
      var pending = rows.filter(function (r) {
        return r.incoming && r.timestamp > (conv.lastReadTs || 0);
      });
      pending.slice(-10).forEach(function (r) {
        App.api.readReceipt(r.author, r.timestamp)['catch'](function (e) {
          App.util.dbg('receipt failed ' + e.message);
        });
      });
      if (pending.length) {
        conv.lastReadTs = pending[pending.length - 1].timestamp;
      }
      persistConv(conv);
    });

    if (hadUnread) emit('conversations');
  }

  function openConversationWith(contact) {
    var convId = contact.number || contact.uuid;
    var conv = convs[convId];
    if (!conv) {
      conv = {
        id: convId,
        type: 'direct',
        sendId: convId,
        name: contact.name || convId,
        lastTs: 0,
        lastPreview: '',
        unread: 0,
        lastReadTs: 0
      };
      convs[convId] = conv;
      persistConv(conv);
      emit('conversations');
    }
    return conv;
  }

  function openGroupConversation(internalId) {
    var convId = 'g:' + internalId;
    var conv = convs[convId];
    if (!conv) {
      var g = groupsByInternal[internalId];
      conv = {
        id: convId,
        type: 'group',
        groupInternalId: internalId,
        sendId: g ? g.id : null,
        name: g ? g.name : 'Group',
        lastTs: 0,
        lastPreview: '',
        unread: 0,
        lastReadTs: 0
      };
      convs[convId] = conv;
      persistConv(conv);
      emit('conversations');
    }
    return conv;
  }

  function init() {
    return App.db.allContacts().then(function (rows) {
      rows.forEach(function (c) {
        if (c.number) contactsByKey[c.number] = c;
        if (c.uuid) contactsByKey[c.uuid] = c;
      });
      return App.db.kvGet('groups');
    }).then(function (g) {
      groupsByInternal = g || {};
      return App.db.allConversations();
    }).then(function (rows) {
      rows.forEach(function (c) { convs[c.id] = c; });
      emit('conversations');
      if (App.config.isConfigured()) {
        refreshDirectory()['catch'](function (e) {
          App.util.dbg('directory refresh failed: ' + e.message);
        });
        App.ws.connect();
      }
    })['catch'](function (e) {
      App.util.dbg('store init failed: ' + e.message);
      App.toast('Storage error: ' + e.message);
    });
  }

  App.store = {
    on: on,
    off: off,
    init: init,
    ingestRaw: ingestRaw,
    refreshDirectory: refreshDirectory,
    sendText: sendText,
    sendAttachment: sendAttachment,
    sendEdit: sendEdit,
    retryMessage: retryMessage,
    reactTo: reactTo,
    deleteForEveryone: deleteForEveryone,
    attachmentLabel: attachmentLabel,
    markRead: markRead,
    openConversationWith: openConversationWith,
    openGroupConversation: openGroupConversation,

    conversations: function () {
      return Object.keys(convs).map(function (k) { return convs[k]; })
        .filter(function (c) { return c.lastTs > 0; })
        .sort(function (a, b) { return b.lastTs - a.lastTs; });
    },

    conversation: function (id) { return convs[id]; },

    contactsList: function () {
      var seen = {};
      var out = [];
      Object.keys(contactsByKey).forEach(function (k) {
        var c = contactsByKey[k];
        if (!seen[c.id]) {
          seen[c.id] = true;
          out.push(c);
        }
      });
      out.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
      return out;
    },

    groupsList: function () {
      return Object.keys(groupsByInternal).map(function (k) {
        return { internal_id: k, id: groupsByInternal[k].id, name: groupsByInternal[k].name };
      }).sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    },

    displayName: displayName,

    typing: function (convId) {
      var t = typingMap[convId];
      return t && t.until > Date.now() ? t : null;
    },

    setOpenConv: function (convId) { openConvId = convId; },

    setConnection: function (s) {
      connection = s;
      emit('connection', s);
    },

    connectionState: function () { return connection; },

    selfNumber: self
  };
})();
