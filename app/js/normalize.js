(function () {
  'use strict';

  /* Single choke point that turns raw websocket frames from
     /v1/receive/{number} into typed events for the store. Envelope shapes
     vary across signal-cli versions, so ALL parsing lives here and unknown
     shapes are logged to the debug ring buffer instead of crashing.

     Emitted event types:
       message      { convId, groupInternalId?, incoming, author, authorName,
                      timestamp, body, quote?, attachments, expiresAt? }
       edit         { convId, author, targetTimestamp, newBody, timestamp }
       reaction     { convId, reactor, emoji, remove, targetAuthor, targetTimestamp }
       remoteDelete { convId, author, targetTimestamp }
       typing       { convId, author, started }
       receipt      { peer, kind: 'delivery'|'read', timestamps: [..] }
       readSync     { entries: [{ sender, timestamp }] }
  */

  function peerKey(env) {
    return env.sourceNumber || env.sourceUuid || env.source || null;
  }

  function convFor(env, dm) {
    var gi = dm && dm.groupInfo;
    if (gi && gi.groupId) {
      return { convId: 'g:' + gi.groupId, groupInternalId: gi.groupId };
    }
    return { convId: peerKey(env), groupInternalId: null };
  }

  /* Signal delivers mentions out-of-band: the body carries a U+FFFC
     object-replacement placeholder at each mention's offset (which renders
     as a tofu box), and a parallel `mentions` array holds the identities.
     Splice the readable "@name" back into the text. Offsets are UTF-16 code
     units, matching JS string indexing. */
  function mentionName(m) {
    if (m.name) return m.name;
    var key = m.number || m.uuid || '';
    if (key && App.store && App.store.displayName) return App.store.displayName(key);
    return key || 'unknown';
  }

  function applyMentions(body, mentions) {
    if (!body || !mentions || !mentions.length) return body || '';
    // Splice from the end so earlier offsets stay valid.
    var sorted = mentions.slice().sort(function (a, b) {
      return (b.start || 0) - (a.start || 0);
    });
    var out = body;
    sorted.forEach(function (m) {
      var start = m.start || 0;
      var len = m.length || 1;
      if (start < 0 || start > out.length) {
        App.util.dbg('normalize: mention offset out of range', m);
        return;
      }
      out = out.slice(0, start) + '@' + mentionName(m) + out.slice(start + len);
    });
    return out;
  }

  function quoteOf(dm) {
    var q = dm.quote;
    if (!q) return null;
    return {
      author: q.authorNumber || q.authorUuid || q.author || '',
      timestamp: q.id || q.timestamp || 0,
      text: q.text || ''
    };
  }

  function dataMessageEvents(env, dm, incoming, authorOverride, convOverride) {
    var events = [];
    var conv = convOverride || convFor(env, dm);
    var author = authorOverride || peerKey(env);
    if (!conv.convId) {
      App.util.dbg('normalize: no conversation for dataMessage', env);
      return events;
    }

    if (dm.reaction) {
      events.push({
        type: 'reaction',
        convId: conv.convId,
        reactor: author,
        emoji: dm.reaction.emoji,
        remove: !!dm.reaction.isRemove,
        targetAuthor: dm.reaction.targetAuthorNumber || dm.reaction.targetAuthorUuid ||
          dm.reaction.targetAuthor || '',
        targetTimestamp: dm.reaction.targetSentTimestamp || dm.reaction.targetTimestamp || 0
      });
      return events;
    }

    if (dm.remoteDelete) {
      events.push({
        type: 'remoteDelete',
        convId: conv.convId,
        author: author,
        targetTimestamp: dm.remoteDelete.timestamp || 0
      });
      return events;
    }

    var attachments = dm.attachments || [];
    var body = dm.message;
    if (body == null && attachments.length === 0 && !dm.sticker) {
      // Group updates, expiration-timer changes etc. — ignore quietly but log.
      App.util.dbg('normalize: dataMessage without body', dm);
      return events;
    }

    events.push({
      type: 'message',
      convId: conv.convId,
      groupInternalId: conv.groupInternalId,
      incoming: incoming,
      author: author,
      authorName: env.sourceName || '',
      timestamp: dm.timestamp || env.timestamp,
      body: applyMentions(body, dm.mentions),
      quote: quoteOf(dm),
      attachments: attachments.map(function (a) {
        return {
          id: a.id || '',
          contentType: a.contentType || '',
          filename: a.filename || '',
          size: a.size || 0
        };
      }),
      expiresInSeconds: dm.expiresInSeconds || 0
    });
    return events;
  }

  function editEvent(env, edit, author, convOverride) {
    var dm = edit.dataMessage || {};
    var conv = convOverride || convFor(env, dm);
    if (!conv.convId) {
      App.util.dbg('normalize: no conversation for editMessage', edit);
      return [];
    }
    return [{
      type: 'edit',
      convId: conv.convId,
      author: author,
      targetTimestamp: edit.targetSentTimestamp || edit.targetTimestamp || 0,
      newBody: dm.message || '',
      timestamp: dm.timestamp || env.timestamp
    }];
  }

  function parse(frame, selfNumber) {
    var events = [];
    var env = frame && frame.envelope;
    if (!env) {
      App.util.dbg('normalize: frame without envelope', frame);
      return events;
    }

    if (env.dataMessage) {
      return dataMessageEvents(env, env.dataMessage, true);
    }

    if (env.editMessage) {
      return editEvent(env, env.editMessage, peerKey(env));
    }

    if (env.typingMessage) {
      var tm = env.typingMessage;
      var tConvId = tm.groupId ? 'g:' + tm.groupId : peerKey(env);
      events.push({
        type: 'typing',
        convId: tConvId,
        author: peerKey(env),
        started: tm.action === 'STARTED'
      });
      return events;
    }

    if (env.receiptMessage) {
      var rm = env.receiptMessage;
      events.push({
        type: 'receipt',
        peer: peerKey(env),
        kind: rm.isRead ? 'read' : (rm.isDelivery ? 'delivery' : 'other'),
        timestamps: rm.timestamps || (rm.when ? [rm.when] : [])
      });
      return events;
    }

    if (env.syncMessage) {
      var sm = env.syncMessage;
      // A message sent from another of our linked devices (e.g. the phone).
      if (sm.sentMessage) {
        var sent = sm.sentMessage;
        var dest = sent.destinationNumber || sent.destinationUuid || sent.destination;
        var conv = sent.groupInfo && sent.groupInfo.groupId
          ? { convId: 'g:' + sent.groupInfo.groupId, groupInternalId: sent.groupInfo.groupId }
          : { convId: dest, groupInternalId: null };
        if (sent.editMessage) {
          // An edit we made on another linked device.
          return editEvent(env, sent.editMessage, selfNumber, conv);
        }
        return dataMessageEvents(env, sent, false, selfNumber, conv);
      }
      if (sm.readMessages) {
        // Messages we read on another linked device: clear unread locally.
        var entries = [];
        sm.readMessages.forEach(function (r) {
          var sender = r.senderNumber || r.senderUuid || r.sender;
          if (sender && r.timestamp) {
            entries.push({ sender: sender, timestamp: r.timestamp });
          }
        });
        if (entries.length) {
          events.push({ type: 'readSync', entries: entries });
        } else {
          App.util.dbg('normalize: empty readMessages', sm.readMessages);
        }
        return events;
      }
      App.util.dbg('normalize: unhandled syncMessage', Object.keys(sm));
      return events;
    }

    App.util.dbg('normalize: unhandled envelope', Object.keys(env));
    return events;
  }

  App.normalize = { parse: parse };
})();
