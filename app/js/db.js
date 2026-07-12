(function () {
  'use strict';

  /* IndexedDB persistence. signal-cli-rest-api has no message-history API,
     so this database IS the message history: everything received over the
     websocket (and everything sent) is stored here.

     Stores:
       messages       keyPath 'id' = convId + '|' + timestamp + '|' + author
                      index 'conv' on [convId, timestamp]
       conversations  keyPath 'id' (peer number/uuid, or 'g:' + internal_id)
       contacts       keyPath 'id' (uuid preferred, else number)
       kv             keyPath 'k'
       attachments    keyPath 'id' (v2) — LRU blob cache for viewed media
  */

  var DB_VERSION = 2;
  var opened = null;

  /* Each account gets its own database. The first (migrated) account keeps the
     legacy un-suffixed name so existing history survives the upgrade. */
  function dbName() {
    if (App.config.activeUsesLegacyDb && App.config.activeUsesLegacyDb()) {
      return 'signal4kaios';
    }
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
    putMessage: function (rec) {
      return tx('messages', 'readwrite', function (s) { s.put(rec); });
    },

    getMessage: function (id) {
      return tx('messages', 'readonly', function (s) { return reqValue(s.get(id)); });
    },

    deleteMessage: function (id) {
      return tx('messages', 'readwrite', function (s) { s['delete'](id); });
    },

    /* Newest `limit` messages in convId strictly older than beforeTs
       (pass Infinity-like large number for the first page). Resolves
       oldest-first for easy DOM append. */
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

    /* Case-insensitive substring search over all message bodies.
       Full-store scan — fine for the pruned volumes this app keeps. */
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

    /* Keep only the `keep` most recently cached attachment blobs.
       Avatar cache entries ('avatar:*') are exempt — they are small and
       bounded by the contact list. */
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
