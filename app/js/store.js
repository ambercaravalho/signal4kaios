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
  var ready = false; // true once IndexedDB history has loaded on startup
  var purgeTimer = null; // periodic disappearing-message sweep

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
    if (conv.muted) return;
    if (!document.hidden) return;
    if (typeof Notification === 'undefined') return;
    try {
      var title = conv.name || 'Signal';
      var body = rec.body || '[attachment]';
      if (conv.type === 'group') body = displayName(rec.author) + ': ' + body;
      var n = new Notification(title, {
        body: body.slice(0, 100),
        tag: conv.id,
        icon: '/assets/icons/kaios_112.png'
      });
      n.onclick = function () {
        try {
          window.focus();
          if (App.openConversation) App.openConversation(conv.id);
        } catch (e2) {
          App.util.dbg('notify click failed ' + e2.message);
        }
        n.close();
      };
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
      styles: ev.styles || [],
      quote: ev.quote || null,
      attachments: ev.attachments || [],
      reactions: {},
      status: ev.incoming ? 'received' : 'sent',
      deleted: false,
      edited: false
    };
    // Disappearing messages: remember the timer on the record so a background
    // sweep can delete it, and track the conversation's current interval so
    // outgoing messages inherit it.
    if (ev.expiresInSeconds) {
      rec.expireSecs = ev.expiresInSeconds;
      rec.expiresAt = Date.now() + ev.expiresInSeconds * 1000;
    }
    if (ev.expiresInSeconds != null &&
        (conv.expireTimer || 0) !== ev.expiresInSeconds) {
      conv.expireTimer = ev.expiresInSeconds;
    }
    App.db.putMessage(rec);

    conv.lastTs = Math.max(conv.lastTs || 0, ev.timestamp);
    conv.lastPreview = previewOf(ev);
    // New activity brings a chat out of the archive. By default (matching
    // Signal) muted archived chats stay archived; when the user turns that
    // option off, muted chats unarchive like any other.
    if (!App.config.keepMutedArchived() || !conv.muted) conv.archived = false;
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
        rec.styles = ev.newStyles || [];
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

  function applyPin(ev, pinned) {
    var candidates = [ev.targetAuthor, altKeyOf(ev.targetAuthor), self()];
    enqueueMutation(function () {
      return findMessage(ev.convId, ev.targetTimestamp, candidates).then(function (rec) {
        if (!rec) {
          App.util.dbg('pin target not found', ev);
          return;
        }
        rec.pinned = pinned;
        emit('message-updated', rec);
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

  /* A message was read on another linked device. Clear the unread badge for
     the matching conversation(s) so this device stays in sync. */
  function applyReadSync(ev) {
    var changed = false;
    (ev.entries || []).forEach(function (entry) {
      var candidates = [entry.sender, altKeyOf(entry.sender)];
      candidates.forEach(function (cid) {
        var conv = cid ? convs[cid] : null;
        if (!conv) return;
        if (conv.unread > 0) { conv.unread = 0; changed = true; }
        if (entry.timestamp > (conv.lastReadTs || 0)) {
          conv.lastReadTs = entry.timestamp;
        }
        persistConv(conv);
      });
    });
    if (changed) emit('conversations');
  }

  function applyEvent(ev) {
    switch (ev.type) {
      case 'message': return applyMessage(ev);
      case 'reaction': return applyReaction(ev);
      case 'remoteDelete': return applyRemoteDelete(ev);
      case 'edit': return applyEdit(ev);
      case 'pin': return applyPin(ev, true);
      case 'unpin': return applyPin(ev, false);
      case 'typing': return applyTyping(ev);
      case 'receipt': return applyReceipt(ev);
      case 'readSync': return applyReadSync(ev);
      default:
        App.util.dbg('unknown event type ' + ev.type);
    }
  }

  function ingestRaw(frame) {
    var events = App.normalize.parse(frame, self());
    events.forEach(applyEvent);
  }

  /* Best display name across the many places Signal keeps names:
     address-book name → nickname → profile name → username → number. */
  function contactName(c) {
    if (c.name) return c.name;
    var nick = c.nickname || {};
    if (nick.name) return nick.name;
    var nn = [nick.given_name, nick.family_name].filter(Boolean).join(' ');
    if (nn) return nn;
    if (c.profile_name) return c.profile_name;
    var p = c.profile || {};
    var pn = [p.given_name, p.lastname].filter(Boolean).join(' ');
    if (pn) return pn;
    return c.username || c.number || c.uuid;
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
          name: contactName(c),
          hasAvatar: c.profile ? !!c.profile.has_avatar : undefined
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
    // Sending also unarchives — unless muted and "keep muted archived" is on.
    if (!App.config.keepMutedArchived() || !conv.muted) conv.archived = false;
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
    var base = {
      id: msgId(conv.id, ts, self()),
      convId: conv.id,
      incoming: false,
      author: self(),
      authorName: '',
      timestamp: ts,
      body: '',
      styles: [],
      quote: null,
      attachments: [],
      reactions: {},
      status: 'pending',
      deleted: false,
      edited: false
    };
    // Inherit the conversation's disappearing-message timer so our own copy
    // is swept on the same schedule the recipient's will be.
    if (conv.expireTimer) {
      base.expireSecs = conv.expireTimer;
      base.expiresAt = ts + conv.expireTimer * 1000;
    }
    return Object.assign(base, extras || {});
  }

  function emitRemovals(removed) {
    (removed || []).forEach(function (r) {
      emit('message-removed', { id: r.id, convId: r.convId, timestamp: r.timestamp });
    });
    if (removed && removed.length) emit('conversations');
    return removed;
  }

  /* Full-store sweep of expired disappearing messages. Used on startup and on
     the periodic timer (not on chat open — that uses purgeExpiredConv). */
  function purgeExpired() {
    return App.db.deleteExpired(Date.now()).then(emitRemovals)['catch'](function (e) {
      App.util.dbg('purge expired failed: ' + e.message);
    });
  }

  /* Conversation-scoped expired sweep: cheap enough to run when a chat opens,
     so an already-expired message never flashes on screen. */
  function purgeExpiredConv(convId) {
    return App.db.deleteExpiredIn(convId, Date.now()).then(emitRemovals)['catch'](function (e) {
      App.util.dbg('purge conv expired failed: ' + e.message);
    });
  }

  function convForSend(convId) {
    var conv = convs[convId];
    if (!conv) throw new Error('Unknown conversation');
    if (!conv.sendId) throw new Error('No send address for this group yet');
    return conv;
  }

  /* When styled text is enabled, parse the markdown the user typed so our local
     copy shows the same formatting the recipient will get (the server strips the
     markers and sends body ranges), and flag the request so the server does that
     conversion. The typed text is kept on the record as `raw` so retry/edit
     re-send the markers, not the already-stripped body. */
  function styledSend(text) {
    if (App.config.styledText() && text) {
      var parsed = App.util.parseStyledMarkdown(text);
      return { body: parsed.body, styles: parsed.styles, textMode: 'styled' };
    }
    return { body: text || '', styles: [], textMode: null };
  }

  function sendText(convId, text, quote) {
    var conv;
    try { conv = convForSend(convId); } catch (e) { return Promise.reject(e); }

    var st = styledSend(text);
    var rec = newOutgoingRec(conv, {
      body: st.body, styles: st.styles, raw: text, quote: quote || null
    });
    var payload = { recipients: [conv.sendId], message: text };
    if (st.textMode) payload.text_mode = st.textMode;
    if (quote) {
      payload.quote_timestamp = quote.timestamp;
      payload.quote_author = quote.author;
      payload.quote_message = quote.text;
    }
    return sendCore(conv, rec, payload, st.body);
  }

  /* dataUri: "data:<mime>;base64,…" (a scaled photo, a picked file, or a
     recorded voice note). meta: optional { contentType, filename, size } used
     for the optimistic local record and preview. */
  function sendAttachment(convId, dataUri, caption, meta) {
    var conv;
    try { conv = convForSend(convId); } catch (e) { return Promise.reject(e); }

    meta = meta || {};
    var contentType = meta.contentType || 'image/jpeg';
    var filename = meta.filename || 'photo.jpg';

    var st = styledSend(caption || '');
    var rec = newOutgoingRec(conv, {
      body: st.body, styles: st.styles, raw: caption || '',
      attachments: [{ id: '', contentType: contentType, filename: filename,
        size: meta.size || 0 }]
    });
    var payload = {
      recipients: [conv.sendId],
      message: caption || '',
      base64_attachments: [dataUri]
    };
    if (st.textMode) payload.text_mode = st.textMode;
    var preview = st.body ||
      (contentType.indexOf('image/') === 0 ? '📷 Photo'
        : attachmentLabel([{ contentType: contentType, filename: filename }]));
    return sendCore(conv, rec, payload, preview);
  }

  /* Edit a previously sent message via /v2/send edit_timestamp. */
  function sendEdit(rec, newText) {
    var conv;
    try { conv = convForSend(rec.convId); } catch (e) { return Promise.reject(e); }

    var st = styledSend(newText);
    var payload = {
      recipients: [conv.sendId],
      message: newText,
      edit_timestamp: rec.timestamp
    };
    if (st.textMode) payload.text_mode = st.textMode;
    return App.api.send(payload).then(function () {
      rec.body = st.body;
      rec.styles = st.styles;
      rec.raw = newText;
      rec.edited = true;
      App.db.putMessage(rec);
      emit('message-updated', rec);
      if (conv.lastTs === rec.timestamp) {
        conv.lastPreview = st.body;
        persistConv(conv);
        emit('conversations');
      }
      return rec;
    });
  }

  function retryMessage(rec) {
    App.db.deleteMessage(rec.id);
    emit('message-removed', rec);
    // Re-send the originally typed text (with any markers) so styling survives.
    return sendText(rec.convId, rec.raw != null ? rec.raw : rec.body, rec.quote);
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

  /* Pin/unpin a group message. Optimistically flip the flag, then call the
     group pin-message endpoint; revert on failure. Signal only supports pinned
     messages in groups. */
  function setPinned(rec, pinned) {
    var conv = convs[rec.convId];
    if (!conv || !conv.sendId) return Promise.reject(new Error('Cannot pin here'));
    if (conv.type !== 'group') {
      return Promise.reject(new Error('Pinning works in groups only'));
    }
    var target = rec.incoming ? rec.author : self();
    rec.pinned = pinned;
    App.db.putMessage(rec);
    emit('message-updated', rec);
    var call = pinned
      ? App.api.pinMessage(conv.sendId, target, rec.timestamp)
      : App.api.unpinMessage(conv.sendId, target, rec.timestamp);
    return call['catch'](function (err) {
      rec.pinned = !pinned;
      App.db.putMessage(rec);
      emit('message-updated', rec);
      throw err;
    });
  }

  function markRead(convId) {
    var conv = convs[convId];
    if (!conv) return;
    var hadUnread = conv.unread > 0;
    conv.unread = 0;

    // Send read receipts for incoming messages newer than lastReadTs, unless
    // the user has disabled read receipts in Settings.
    App.db.getMessagesPage(convId, 9007199254740991, 25).then(function (rows) {
      var pending = rows.filter(function (r) {
        return r.incoming && r.timestamp > (conv.lastReadTs || 0);
      });
      if (App.config.sendReadReceipts()) {
        pending.slice(-10).forEach(function (r) {
          App.api.readReceipt(r.author, r.timestamp)['catch'](function (e) {
            App.util.dbg('receipt failed ' + e.message);
          });
        });
      }
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
      ready = true;
      emit('conversations');
      purgeExpired();
      if (!purgeTimer) purgeTimer = setInterval(purgeExpired, 30000);
      if (App.config.isConfigured()) {
        refreshDirectory()['catch'](function (e) {
          App.util.dbg('directory refresh failed: ' + e.message);
        });
        App.ws.connect();
      }
    })['catch'](function (e) {
      ready = true;
      emit('conversations');
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
        .filter(function (c) { return c.lastTs > 0 && !c.archived; })
        .sort(function (a, b) {
          // Pinned conversations float to the top, then most-recent-first.
          if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
          return b.lastTs - a.lastTs;
        });
    },

    archivedConversations: function () {
      return Object.keys(convs).map(function (k) { return convs[k]; })
        .filter(function (c) { return c.lastTs > 0 && c.archived; })
        .sort(function (a, b) { return b.lastTs - a.lastTs; });
    },

    setArchived: function (convId, val) {
      var conv = convs[convId];
      if (!conv) return;
      conv.archived = !!val;
      persistConv(conv);
      emit('conversations');
    },

    setMuted: function (convId, val) {
      var conv = convs[convId];
      if (!conv) return;
      conv.muted = !!val;
      persistConv(conv);
      emit('conversations');
    },

    /* Record the conversation's disappearing-message interval (seconds) so new
       outgoing messages inherit it. The server-side change is done by the
       caller via updateContact / updateGroup. */
    setConvExpire: function (convId, secs) {
      var conv = convs[convId];
      if (!conv) return;
      conv.expireTimer = secs || 0;
      persistConv(conv);
    },

    convExpire: function (convId) {
      var conv = convs[convId];
      return (conv && conv.expireTimer) || 0;
    },

    /* Pin/unpin a conversation to the top of the list. Local only — Signal has
       no REST endpoint for conversation pins, so this does not sync. */
    setConvPinned: function (convId, val) {
      var conv = convs[convId];
      if (!conv) return;
      conv.pinned = !!val;
      persistConv(conv);
      emit('conversations');
    },

    setPinned: setPinned,
    purgeExpired: purgeExpired,
    purgeExpiredConv: purgeExpiredConv,

    conversation: function (id) { return convs[id]; },

    setConversationName: function (convId, name) {
      var conv = convs[convId];
      if (!conv || !name) return;
      conv.name = name;
      persistConv(conv);
      emit('conversations');
    },

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
    contactByKey: contactOf,

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

    isReady: function () { return ready; },

    selfNumber: self
  };
})();
