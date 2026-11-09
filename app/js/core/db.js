(function () {
  'use strict';

  /* IndexedDB persistence. Signal has no server-side message history, so this database IS the message history: everything received over the websocket (and everything sent) is stored here, alongside the on-device Signal Protocol state.

     Stores:
       messages       keyPath 'id' = convId + '|' + timestamp + '|' + author
                      index 'conv' on [convId, timestamp]
       conversations  keyPath 'id' (peer number/uuid, or 'g:' + internal_id)
       contacts       keyPath 'id' (uuid preferred, else number)
       kv             keyPath 'k'
       attachments    keyPath 'id' (v2) — LRU blob cache for viewed media
       signal_keystore    keyPath 'k' (v3) — local Signal identity & registration state
       signal_identities  keyPath 'address' (v3) — remote peer identity keys & trust status
       signal_sessions    keyPath 'address' (v3) — serialized libsignal SessionRecord (<serviceId>.<deviceId>)
       signal_prekeys     keyPath 'id' (v3) — serialized libsignal PreKey, SignedPreKey, and KyberPreKey records
       signal_sender_keys keyPath 'id' (v3) — serialized libsignal SenderKeyRecord (<serviceId>.<deviceId>::<distributionId>)

     v4 switched the protocol state to records produced by Signal's official libsignal. v3 state came from the old hand-written engine and is not readable by libsignal, so the upgrade clears every signal_* store and the device must be linked again (messages, conversations, and contacts are kept).
  */

  var DB_VERSION = 4;
  var SIGNAL_STORES = ['signal_keystore', 'signal_identities', 'signal_sessions', 'signal_prekeys', 'signal_sender_keys'];
  var opened = null;
  var signalStateReset = false;

  /* Each account gets its own database. */
  function dbName() {
    var num = App.config.number();
    return num ? 'signal4kaios:' + num : 'signal4kaios';
  }

  function open() {
    if (opened) return opened;
    opened = new Promise(function (resolve, reject) {
      var req = indexedDB.open(dbName(), DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('messages')) {
          var msgs = db.createObjectStore('messages', { keyPath: 'id' });
          msgs.createIndex('conv', ['convId', 'timestamp'], { unique: false });
        }
        if (!db.objectStoreNames.contains('conversations')) {
          db.createObjectStore('conversations', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('contacts')) {
          db.createObjectStore('contacts', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv', { keyPath: 'k' });
        }
        if (!db.objectStoreNames.contains('attachments')) {
          db.createObjectStore('attachments', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('signal_keystore')) {
          db.createObjectStore('signal_keystore', { keyPath: 'k' });
        }
        if (!db.objectStoreNames.contains('signal_identities')) {
          db.createObjectStore('signal_identities', { keyPath: 'address' });
        }
        if (!db.objectStoreNames.contains('signal_sessions')) {
          db.createObjectStore('signal_sessions', { keyPath: 'address' });
        }
        if (!db.objectStoreNames.contains('signal_prekeys')) {
          db.createObjectStore('signal_prekeys', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('signal_sender_keys')) {
          db.createObjectStore('signal_sender_keys', { keyPath: 'id' });
        }
        if (e.oldVersion > 0 && e.oldVersion < 4) {
          var upgrade = e.target.transaction;
          SIGNAL_STORES.forEach(function (name) { upgrade.objectStore(name).clear(); });
          signalStateReset = true;
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return opened;
  }

  function tx(storeName, mode, work) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, mode);
        var store = t.objectStore(storeName);
        var result = work(store);
        t.oncomplete = function () { resolve(result && result.value); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  function reqValue(request) {
    var out = { value: undefined };
    request.onsuccess = function () { out.value = request.result; };
    return out;
  }

  function getAll(storeName) {
    return tx(storeName, 'readonly', function (store) {
      var out = { value: [] };
      store.openCursor().onsuccess = function (e) {
        var cur = e.target.result;
        if (cur) {
          out.value.push(cur.value);
          cur['continue']();
        }
      };
      return out;
    });
  }

  App.db = {
    /* Opens (and if needed upgrades) the active account's database. */
    ready: function () {
      return open().then(function () {});
    },

    /* True when this launch upgraded a pre-libsignal (v3) database and discarded its protocol state; the device has to be linked again. */
    signalStateWasReset: function () {
      return signalStateReset;
    },

    putMessage: function (rec) {
      return tx('messages', 'readwrite', function (s) { s.put(rec); });
    },

    getMessage: function (id) {
      return tx('messages', 'readonly', function (s) { return reqValue(s.get(id)); });
    },

    deleteMessage: function (id) {
      return tx('messages', 'readwrite', function (s) { s['delete'](id); });
    },

    /* Newest `limit` messages in convId strictly older than beforeTs (pass Infinity-like large number for the first page). Resolves oldest-first for easy DOM append. */
    getMessagesPage: function (convId, beforeTs, limit) {
      return tx('messages', 'readonly', function (s) {
        var out = { value: [] };
        var range = IDBKeyRange.bound([convId, 0], [convId, beforeTs], false, true);
        s.index('conv').openCursor(range, 'prev').onsuccess = function (e) {
          var cur = e.target.result;
          if (cur && out.value.length < limit) {
            out.value.push(cur.value);
            cur['continue']();
          }
        };
        return out;
      }).then(function (rows) {
        rows.reverse();
        return rows;
      });
    },

    /* All pinned (and not deleted) messages in a conversation, oldest-first. */
    getPinned: function (convId) {
      return tx('messages', 'readonly', function (s) {
        var out = { value: [] };
        var range = IDBKeyRange.bound([convId, 0], [convId, 9007199254740991]);
        s.index('conv').openCursor(range).onsuccess = function (e) {
          var cur = e.target.result;
          if (!cur) return;
          if (cur.value.pinned && !cur.value.deleted) out.value.push(cur.value);
          cur['continue']();
        };
        return out;
      });
    },

    countMessages: function (convId) {
      return tx('messages', 'readonly', function (s) {
        var range = IDBKeyRange.bound([convId, 0], [convId, 9007199254740991]);
        return reqValue(s.index('conv').count(range));
      });
    },

    /* Keep only the newest `keep` messages of a conversation. */
    pruneConversation: function (convId, keep) {
      return tx('messages', 'readwrite', function (s) {
        var seen = { value: 0 };
        var range = IDBKeyRange.bound([convId, 0], [convId, 9007199254740991]);
        s.index('conv').openCursor(range, 'prev').onsuccess = function (e) {
          var cur = e.target.result;
          if (!cur) return;
          seen.value += 1;
          if (seen.value > keep) cur['delete']();
          cur['continue']();
        };
        return seen;
      });
    },

    /* Delete every message whose disappearing-message deadline has passed. Resolves to the list of removed { id, convId, timestamp } so the store can update open chats and conversation previews. This is a full-store scan — use it for the periodic background sweep, not on a hot path. */
    deleteExpired: function (now) {
      return tx('messages', 'readwrite', function (s) {
        var out = { value: [] };
        s.openCursor().onsuccess = function (e) {
          var cur = e.target.result;
          if (!cur) return;
          var rec = cur.value;
          if (rec.expiresAt && rec.expiresAt <= now) {
            out.value.push({ id: rec.id, convId: rec.convId, timestamp: rec.timestamp });
            cur['delete']();
          }
          cur['continue']();
        };
        return out;
      });
    },

    /* Same as deleteExpired but scoped to one conversation via the `conv` index, so it only walks that chat's (pruned, ~500-max) messages. Cheap enough to run when a chat is opened. */
    deleteExpiredIn: function (convId, now) {
      return tx('messages', 'readwrite', function (s) {
        var out = { value: [] };
        var range = IDBKeyRange.bound([convId, 0], [convId, 9007199254740991]);
        s.index('conv').openCursor(range).onsuccess = function (e) {
          var cur = e.target.result;
          if (!cur) return;
          var rec = cur.value;
          if (rec.expiresAt && rec.expiresAt <= now) {
            out.value.push({ id: rec.id, convId: rec.convId, timestamp: rec.timestamp });
            cur['delete']();
          }
          cur['continue']();
        };
        return out;
      });
    },

    /* Case-insensitive substring search over all message bodies. Full-store scan — fine for the pruned volumes this app keeps. */
    searchMessages: function (query, limit) {
      var q = query.toLowerCase();
      return tx('messages', 'readonly', function (s) {
        var out = { value: [] };
        s.openCursor().onsuccess = function (e) {
          var cur = e.target.result;
          if (!cur) return;
          var rec = cur.value;
          if (!rec.deleted && rec.body && rec.body.toLowerCase().indexOf(q) >= 0) {
            out.value.push(rec);
          }
          cur['continue']();
        };
        return out;
      }).then(function (rows) {
        rows.sort(function (a, b) { return b.timestamp - a.timestamp; });
        return rows.slice(0, limit || 50);
      });
    },

    putAttachment: function (id, blob, type) {
      return tx('attachments', 'readwrite', function (s) {
        s.put({ id: id, blob: blob, type: type || '', ts: Date.now() });
      });
    },

    getAttachment: function (id) {
      return tx('attachments', 'readonly', function (s) { return reqValue(s.get(id)); });
    },

    /* Keep only the `keep` most recently cached attachment blobs. Avatar cache entries ('avatar:*') are exempt — they are small and bounded by the contact list. */
    pruneAttachments: function (keep) {
      return getAll('attachments').then(function (rows) {
        rows = rows.filter(function (r) {
          return String(r.id).indexOf('avatar:') !== 0;
        });
        if (rows.length <= keep) return;
        rows.sort(function (a, b) { return b.ts - a.ts; });
        var drop = rows.slice(keep);
        return tx('attachments', 'readwrite', function (s) {
          drop.forEach(function (r) { s['delete'](r.id); });
        });
      });
    },

    putConversation: function (conv) {
      return tx('conversations', 'readwrite', function (s) { s.put(conv); });
    },

    deleteConversation: function (id) {
      return tx('conversations', 'readwrite', function (s) { s['delete'](id); });
    },

    allConversations: function () { return getAll('conversations'); },

    putContacts: function (list) {
      return tx('contacts', 'readwrite', function (s) {
        list.forEach(function (c) { s.put(c); });
      });
    },

    allContacts: function () { return getAll('contacts'); },

    kvSet: function (k, v) {
      return tx('kv', 'readwrite', function (s) { s.put({ k: k, v: v }); });
    },

    kvGet: function (k) {
      return tx('kv', 'readonly', function (s) { return reqValue(s.get(k)); })
        .then(function (row) { return row ? row.v : undefined; });
    },

    /* ---- On-device Signal Protocol stores (libsignal records since v4) ---- */

    signalKeySet: function (k, v) {
      return tx('signal_keystore', 'readwrite', function (s) { s.put({ k: k, v: v }); });
    },

    signalKeyGet: function (k) {
      return tx('signal_keystore', 'readonly', function (s) { return reqValue(s.get(k)); })
        .then(function (row) { return row ? row.v : undefined; });
    },

    signalKeyAll: function () { return getAll('signal_keystore'); },

    putIdentity: function (rec) {
      return tx('signal_identities', 'readwrite', function (s) { s.put(rec); });
    },

    getIdentity: function (address) {
      return tx('signal_identities', 'readonly', function (s) { return reqValue(s.get(address)); });
    },

    allIdentities: function () { return getAll('signal_identities'); },

    putSession: function (address, data) {
      return tx('signal_sessions', 'readwrite', function (s) { s.put({ address: address, data: data, updatedAt: Date.now() }); });
    },

    getSession: function (address) {
      return tx('signal_sessions', 'readonly', function (s) { return reqValue(s.get(address)); })
        .then(function (row) { return row ? row.data : undefined; });
    },

    deleteSession: function (address) {
      return tx('signal_sessions', 'readwrite', function (s) { s['delete'](address); });
    },

    allSessions: function () { return getAll('signal_sessions'); },

    putPreKey: function (id, data) {
      return tx('signal_prekeys', 'readwrite', function (s) { s.put({ id: id, data: data }); });
    },

    getPreKey: function (id) {
      return tx('signal_prekeys', 'readonly', function (s) { return reqValue(s.get(id)); })
        .then(function (row) { return row ? row.data : undefined; });
    },

    deletePreKey: function (id) {
      return tx('signal_prekeys', 'readwrite', function (s) { s['delete'](id); });
    },

    allPreKeys: function () { return getAll('signal_prekeys'); },

    putSenderKey: function (id, data) {
      return tx('signal_sender_keys', 'readwrite', function (s) { s.put({ id: id, data: data }); });
    },

    getSenderKey: function (id) {
      return tx('signal_sender_keys', 'readonly', function (s) { return reqValue(s.get(id)); })
        .then(function (row) { return row ? row.data : undefined; });
    },

    /* Drop every protocol record (identity, sessions, PreKeys, sender keys) for the active account, keeping message history. Used before linking again. */
    clearSignalState: function () {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(SIGNAL_STORES, 'readwrite');
          SIGNAL_STORES.forEach(function (name) { t.objectStore(name).clear(); });
          t.oncomplete = function () { resolve(); };
          t.onerror = function () { reject(t.error); };
          t.onabort = function () { reject(t.error); };
        });
      });
    },

    wipe: function () {
      return open().then(function (db) {
        db.close();
        opened = null;
        return new Promise(function (resolve, reject) {
          var req = indexedDB.deleteDatabase(dbName());
          req.onsuccess = function () { resolve(); };
          req.onerror = function () { reject(req.error); };
        });
      });
    }
  };
})();
