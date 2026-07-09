(function () {
  'use strict';

  /* Single choke point that turns raw websocket frames from
     /v1/receive/{number} into typed events for the store. Envelope shapes
     vary across signal-cli versions, so ALL parsing lives here and unknown
     shapes are logged to the debug ring buffer instead of crashing.

     Emitted event types:
       message      { convId, groupInternalId?, incoming, author, authorName,
                      timestamp, body, quote?, attachmentsCount, expiresAt? }
       reaction     { convId, reactor, emoji, remove, targetAuthor, targetTimestamp }
       remoteDelete { convId, author, targetTimestamp }
       typing       { convId, author, started }
       receipt      { peer, kind: 'delivery'|'read', timestamps: [..] }
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
      body: body || (attachments.length ? '' : ''),
      quote: quoteOf(dm),
      attachmentsCount: attachments.length,
      expiresInSeconds: dm.expiresInSeconds || 0
    });
    return events;
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
        return dataMessageEvents(env, sent, false, selfNumber, conv);
      }
      if (sm.readMessages) {
        // Read on another device — could clear unread badges. Log for now.
        App.util.dbg('normalize: syncMessage.readMessages', sm.readMessages);
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
