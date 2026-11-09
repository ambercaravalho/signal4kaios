/* IndexedDB persistence, one database per account (`signal4kaios:<number>`). Signal keeps no message history on its servers, so this database is the history, alongside the libsignal protocol state.

   Stores: messages (index `conv` on [convId, timestamp]), conversations, contacts, kv, attachments (LRU blob cache), and the signal_* protocol stores. v4 switched to libsignal records; upgrading from v3 clears the signal_* stores and the phone must be linked again. */

import type { HostDb } from '../../engine/host';
import { config } from './config';
import type { Contact, Conversation, Message } from './types';

const DB_VERSION = 4;
const SIGNAL_STORES = ['signal_keystore', 'signal_identities', 'signal_sessions', 'signal_prekeys', 'signal_sender_keys'];
const MAX_TS = 9007199254740991;

let opened: Promise<IDBDatabase> | null = null;
let signalStateReset = false;
let accountOverride: string | null = null;

function dbName(): string {
  const num = accountOverride !== null ? accountOverride : config.number();
  return num ? 'signal4kaios:' + num : 'signal4kaios';
}

function open(): Promise<IDBDatabase> {
  if (opened) return opened;
  opened = new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(), DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      const has = (n: string) => db.objectStoreNames.contains(n);
      if (!has('messages')) db.createObjectStore('messages', { keyPath: 'id' }).createIndex('conv', ['convId', 'timestamp'], { unique: false });
      if (!has('conversations')) db.createObjectStore('conversations', { keyPath: 'id' });
      if (!has('contacts')) db.createObjectStore('contacts', { keyPath: 'id' });
      if (!has('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      if (!has('attachments')) db.createObjectStore('attachments', { keyPath: 'id' });
      if (!has('signal_keystore')) db.createObjectStore('signal_keystore', { keyPath: 'k' });
      if (!has('signal_identities')) db.createObjectStore('signal_identities', { keyPath: 'address' });
      if (!has('signal_sessions')) db.createObjectStore('signal_sessions', { keyPath: 'address' });
      if (!has('signal_prekeys')) db.createObjectStore('signal_prekeys', { keyPath: 'id' });
      if (!has('signal_sender_keys')) db.createObjectStore('signal_sender_keys', { keyPath: 'id' });
      if (e.oldVersion > 0 && e.oldVersion < 4) {
        const upgrade = req.transaction!;
        for (const name of SIGNAL_STORES) upgrade.objectStore(name).clear();
        signalStateReset = true;
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opened;
}

/* `work` returns a holder whose `value` is filled by request callbacks; the transaction resolves with it once complete. */
function tx<T>(storeName: string, mode: IDBTransactionMode, work: (s: IDBObjectStore) => { value: T } | void): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const result = work(t.objectStore(storeName));
        t.oncomplete = () => resolve((result ? result.value : undefined) as T);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

function reqValue<T>(request: IDBRequest<T>): { value: T | undefined } {
  const out: { value: T | undefined } = { value: undefined };
  request.onsuccess = () => {
    out.value = request.result;
  };
  return out;
}

function getAll<T>(storeName: string): Promise<T[]> {
  return tx<T[]>(storeName, 'readonly', (s) => {
    const out = { value: [] as T[] };
    s.openCursor().onsuccess = (e) => {
      const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (cur) {
        out.value.push(cur.value);
        cur.continue();
      }
    };
    return out;
  });
}

function convRange(convId: string, upper = MAX_TS, upperOpen = false): IDBKeyRange {
  return IDBKeyRange.bound([convId, 0], [convId, upper], false, upperOpen);
}

/** Delete the expired messages `source`'s cursor walks over; resolves to what was deleted. */
function sweep(source: (s: IDBObjectStore) => IDBRequest<IDBCursorWithValue | null>, now: number): Promise<Array<{ id: string; convId: string; timestamp: number }>> {
  return tx('messages', 'readwrite', (s) => {
    const out = { value: [] as Array<{ id: string; convId: string; timestamp: number }> };
    source(s).onsuccess = (e) => {
      const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (!cur) return;
      const rec = cur.value as Message;
      if (rec.expiresAt && rec.expiresAt <= now) {
        out.value.push({ id: rec.id, convId: rec.convId, timestamp: rec.timestamp });
        cur.delete();
      }
      cur.continue();
    };
    return out;
  });
}

export interface ExpiredRef {
  id: string;
  convId: string;
  timestamp: number;
}

export const db = {
  name(): string {
    return dbName();
  },

  ready(): Promise<void> {
    return open().then(() => {});
  },

  /** Use `number`'s database instead of the active account's (or the active one again with null). Linking calls this before saving keys, since the new account isn't active until the reload that follows. */
  useAccount(number: string | null): Promise<void> {
    const prev = opened;
    opened = null;
    accountOverride = number === null ? null : number || '';
    return (prev || Promise.resolve(null))
      .then(
        (d) => {
          if (d) d.close();
        },
        () => {}
      )
      .then(open)
      .then(() => {});
  },

  /** True when this launch upgraded a pre-libsignal database and discarded its protocol state. */
  signalStateWasReset(): boolean {
    return signalStateReset;
  },

  putMessage(rec: Message): Promise<void> {
    return tx('messages', 'readwrite', (s) => {
      s.put(rec);
    });
  },

  getMessage(id: string): Promise<Message | undefined> {
    return tx('messages', 'readonly', (s) => reqValue(s.get(id)));
  },

  deleteMessage(id: string): Promise<void> {
    return tx('messages', 'readwrite', (s) => {
      s.delete(id);
    });
  },

  /** The newest `limit` messages strictly older than `beforeTs`, oldest first. */
  getMessagesPage(convId: string, beforeTs: number, limit: number): Promise<Message[]> {
    return tx<Message[]>('messages', 'readonly', (s) => {
      const out = { value: [] as Message[] };
      s.index('conv').openCursor(convRange(convId, beforeTs, true), 'prev').onsuccess = (e) => {
        const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (cur && out.value.length < limit) {
          out.value.push(cur.value);
          cur.continue();
        }
      };
      return out;
    }).then((rows) => rows.reverse());
  },

  /** Pinned, not deleted messages in a chat, oldest first. */
  getPinned(convId: string): Promise<Message[]> {
    return tx<Message[]>('messages', 'readonly', (s) => {
      const out = { value: [] as Message[] };
      s.index('conv').openCursor(convRange(convId)).onsuccess = (e) => {
        const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (!cur) return;
        if (cur.value.pinned && !cur.value.deleted) out.value.push(cur.value);
        cur.continue();
      };
      return out;
    });
  },

  countMessages(convId: string): Promise<number> {
    return tx<number>('messages', 'readonly', (s) => reqValue(s.index('conv').count(convRange(convId))) as { value: number });
  },

  /** Keep only the newest `keep` messages of a chat. */
  pruneConversation(convId: string, keep: number): Promise<void> {
    return tx('messages', 'readwrite', (s) => {
      let seen = 0;
      s.index('conv').openCursor(convRange(convId), 'prev').onsuccess = (e) => {
        const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (!cur) return;
        seen += 1;
        if (seen > keep) cur.delete();
        cur.continue();
      };
    });
  },

  /** Delete a chat's messages sent at or before `ts`; resolves to what was deleted. */
  deleteMessagesUpTo(convId: string, ts: number): Promise<ExpiredRef[]> {
    return tx('messages', 'readwrite', (s) => {
      const out = { value: [] as ExpiredRef[] };
      s.index('conv').openCursor(convRange(convId, ts)).onsuccess = (e) => {
        const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (!cur) return;
        const rec = cur.value as Message;
        out.value.push({ id: rec.id, convId: rec.convId, timestamp: rec.timestamp });
        cur.delete();
        cur.continue();
      };
      return out;
    });
  },

  /** Delete every message past its disappearing deadline. A full scan, for the periodic sweep. */
  deleteExpired(now: number): Promise<ExpiredRef[]> {
    return sweep((s) => s.openCursor(), now);
  },

  /** The same, for one chat only; cheap enough to run when the chat opens. */
  deleteExpiredIn(convId: string, now: number): Promise<ExpiredRef[]> {
    return sweep((s) => s.index('conv').openCursor(convRange(convId)), now);
  },

  /** Case-insensitive substring search over message text, newest first. */
  searchMessages(query: string, limit = 50): Promise<Message[]> {
    const q = query.toLowerCase();
    return tx<Message[]>('messages', 'readonly', (s) => {
      const out = { value: [] as Message[] };
      s.openCursor().onsuccess = (e) => {
        const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (!cur) return;
        const rec = cur.value as Message;
        if (!rec.deleted && rec.body && rec.body.toLowerCase().indexOf(q) >= 0) out.value.push(rec);
        cur.continue();
      };
      return out;
    }).then((rows) => rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit));
  },

  putAttachment(id: string, blob: Blob, type: string): Promise<void> {
    return tx('attachments', 'readwrite', (s) => {
      s.put({ id, blob, type: type || '', ts: Date.now() });
    });
  },

  getAttachment(id: string): Promise<{ blob: Blob; type: string } | undefined> {
    return tx('attachments', 'readonly', (s) => reqValue(s.get(id)));
  },

  /** Keep only the `keep` most recently cached attachments. Avatars (`avatar:*`) are exempt: they are small and bounded by the contact list. */
  pruneAttachments(keep: number): Promise<void> {
    return getAll<{ id: string; ts: number }>('attachments').then((rows) => {
      rows = rows.filter((r) => String(r.id).indexOf('avatar:') !== 0);
      if (rows.length <= keep) return;
      rows.sort((a, b) => b.ts - a.ts);
      const drop = rows.slice(keep);
      return tx('attachments', 'readwrite', (s) => {
        for (const r of drop) s.delete(r.id);
      });
    });
  },

  putConversation(conv: Conversation): Promise<void> {
    return tx('conversations', 'readwrite', (s) => {
      s.put(conv);
    });
  },

  deleteConversation(id: string): Promise<void> {
    return tx('conversations', 'readwrite', (s) => {
      s.delete(id);
    });
  },

  allConversations(): Promise<Conversation[]> {
    return getAll('conversations');
  },

  putContacts(list: Contact[]): Promise<void> {
    return tx('contacts', 'readwrite', (s) => {
      for (const c of list) s.put(c);
    });
  },

  allContacts(): Promise<Contact[]> {
    return getAll('contacts');
  },

  kvSet(k: string, v: unknown): Promise<void> {
    return tx('kv', 'readwrite', (s) => {
      s.put({ k, v });
    });
  },

  kvGet(k: string): Promise<any> {
    return tx<{ v: unknown } | undefined>('kv', 'readonly', (s) => reqValue(s.get(k))).then((row) => (row ? row.v : undefined));
  },

  signalKeySet(k: string, v: unknown): Promise<void> {
    return tx('signal_keystore', 'readwrite', (s) => {
      s.put({ k, v });
    });
  },

  signalKeyGet(k: string): Promise<any> {
    return tx<{ v: unknown } | undefined>('signal_keystore', 'readonly', (s) => reqValue(s.get(k))).then((row) => (row ? row.v : undefined));
  },

  putIdentity(rec: unknown): Promise<void> {
    return tx('signal_identities', 'readwrite', (s) => {
      s.put(rec);
    });
  },

  getIdentity(address: string): Promise<any> {
    return tx('signal_identities', 'readonly', (s) => reqValue(s.get(address)));
  },

  allIdentities(): Promise<any[]> {
    return getAll('signal_identities');
  },

  putSession(address: string, data: Uint8Array): Promise<void> {
    return tx('signal_sessions', 'readwrite', (s) => {
      s.put({ address, data, updatedAt: Date.now() });
    });
  },

  getSession(address: string): Promise<Uint8Array | undefined> {
    return tx<{ data: Uint8Array } | undefined>('signal_sessions', 'readonly', (s) => reqValue(s.get(address))).then((row) => (row ? row.data : undefined));
  },

  deleteSession(address: string): Promise<void> {
    return tx('signal_sessions', 'readwrite', (s) => {
      s.delete(address);
    });
  },

  allSessions(): Promise<any[]> {
    return getAll('signal_sessions');
  },

  putPreKey(id: string, data: Uint8Array): Promise<void> {
    return tx('signal_prekeys', 'readwrite', (s) => {
      s.put({ id, data });
    });
  },

  getPreKey(id: string): Promise<Uint8Array | undefined> {
    return tx<{ data: Uint8Array } | undefined>('signal_prekeys', 'readonly', (s) => reqValue(s.get(id))).then((row) => (row ? row.data : undefined));
  },

  deletePreKey(id: string): Promise<void> {
    return tx('signal_prekeys', 'readwrite', (s) => {
      s.delete(id);
    });
  },

  putSenderKey(id: string, data: Uint8Array): Promise<void> {
    return tx('signal_sender_keys', 'readwrite', (s) => {
      s.put({ id, data });
    });
  },

  getSenderKey(id: string): Promise<Uint8Array | undefined> {
    return tx<{ data: Uint8Array } | undefined>('signal_sender_keys', 'readonly', (s) => reqValue(s.get(id))).then((row) => (row ? row.data : undefined));
  },

  /** Drop the active account's protocol records (identity, sessions, PreKeys, sender keys) but keep its history. Used before linking again. */
  clearSignalState(): Promise<void> {
    return open().then(
      (d) =>
        new Promise<void>((resolve, reject) => {
          const t = d.transaction(SIGNAL_STORES, 'readwrite');
          for (const name of SIGNAL_STORES) t.objectStore(name).clear();
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        })
    );
  },

  wipe(): Promise<void> {
    return open().then((d) => {
      d.close();
      opened = null;
      return new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(dbName());
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    });
  },
} satisfies HostDb & Record<string, unknown>;
