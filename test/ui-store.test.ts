import './ui-env';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { forgetUnlinkedDevice, setReadReceipts, setTypingIndicators, signal, updateProfile } from '../src/ui/data/api';
import { autoDownloads, cachedAttachment, loadAttachment, ViewedOnceError } from '../src/ui/data/attachments';
import { config } from '../src/ui/data/config';
import { db } from '../src/ui/data/db';
import * as store from '../src/ui/data/store';
import { migrateMute, MUTED_ALWAYS } from '../src/ui/data/store/mute';
import { state as storeState } from '../src/ui/data/store/state';
import { outOfGroup } from '../src/ui/screens/group-perms';
import { S } from '../src/ui/strings';
import { settle } from './helpers';

const ME = '+15550000';
const ALICE = '+15550001';

function incoming(ts: number, body: string, extra: Record<string, unknown> = {}) {
  return { envelope: { sourceNumber: ALICE, sourceName: 'Alice', timestamp: ts, dataMessage: { timestamp: ts, message: body, ...extra } } };
}

describe('store', () => {
  before(async () => {
    config.set({ number: ME, aci: 'aci-me', deviceId: 2, deviceToken: 'test-only' });
    await db.ready();
    await db.kvSet('syncedContacts', [{ uuid: '', number: ALICE, name: 'Alice' }]);
    await store.refreshDirectory();
  });

  it('stores an incoming message and counts it unread', async () => {
    store.ingestRaw(incoming(1000, 'hello'));
    await settle();
    const rec = await db.getMessage(ALICE + '|1000|' + ALICE);
    assert.ok(rec);
    assert.equal(rec.body, 'hello');
    assert.equal(rec.status, 'received');
    const conv = store.conversation(ALICE)!;
    assert.equal(conv.unread, 1);
    assert.equal(conv.lastPreview, 'hello');
    assert.equal(conv.name, 'Alice');
    assert.deepEqual(
      store.conversations().map((c) => c.id),
      [ALICE]
    );
  });

  it('applies edits, reactions, and deletes to the stored message', async () => {
    store.ingestRaw({ envelope: { sourceNumber: ALICE, timestamp: 1100, editMessage: { targetSentTimestamp: 1000, dataMessage: { message: 'hello, edited' } } } });
    store.ingestRaw({ envelope: { sourceNumber: ALICE, timestamp: 1200, dataMessage: { reaction: { emoji: '👍', targetAuthorNumber: ALICE, targetSentTimestamp: 1000 } } } });
    await settle();
    let rec = (await db.getMessage(ALICE + '|1000|' + ALICE))!;
    assert.equal(rec.body, 'hello, edited');
    assert.equal(rec.edited, true);
    assert.deepEqual(rec.reactions, { [ALICE]: '👍' });
    assert.equal(store.conversation(ALICE)!.lastPreview, 'hello, edited');

    store.ingestRaw({ envelope: { sourceNumber: ALICE, timestamp: 1300, dataMessage: { reaction: { emoji: '👍', isRemove: true, targetAuthorNumber: ALICE, targetSentTimestamp: 1000 } } } });
    store.ingestRaw({ envelope: { sourceNumber: ALICE, timestamp: 1400, dataMessage: { remoteDelete: { timestamp: 1000 } } } });
    await settle();
    rec = (await db.getMessage(ALICE + '|1000|' + ALICE))!;
    assert.deepEqual(rec.reactions, {});
    assert.equal(rec.deleted, true);
    assert.equal(rec.body, '');
  });

  it('keeps earlier versions of edited messages once each', async () => {
    store.ingestRaw(incoming(1500, 'first'));
    store.ingestRaw({ envelope: { sourceNumber: ALICE, timestamp: 1600, editMessage: { targetSentTimestamp: 1500, dataMessage: { timestamp: 1600, message: 'second' } } } });
    store.ingestRaw({ envelope: { sourceNumber: ALICE, timestamp: 1600, editMessage: { targetSentTimestamp: 1500, dataMessage: { timestamp: 1600, message: 'second' } } } });
    store.ingestRaw({ envelope: { sourceNumber: ALICE, timestamp: 1700, editMessage: { targetSentTimestamp: 1500, dataMessage: { timestamp: 1700, message: 'third' } } } });
    await settle();
    const rec = (await db.getMessage(ALICE + '|1500|' + ALICE))!;
    assert.equal(rec.body, 'third');
    assert.equal(rec.editedAt, 1700);
    assert.deepEqual(rec.history, [
      { body: 'first', styles: [], timestamp: 1500 },
      { body: 'second', styles: [], timestamp: 1600 },
    ]);
  });

  it('applies your own edits from another device, but not someone else’s edit of your message', async () => {
    const sentAt = 1800;
    store.ingestRaw({ envelope: { sourceNumber: ME, timestamp: sentAt, syncMessage: { sentMessage: { destinationNumber: ALICE, timestamp: sentAt, message: 'see you at 6' } } } });
    await settle();
    const id = ALICE + '|' + sentAt + '|' + ME;
    assert.equal((await db.getMessage(id))!.body, 'see you at 6');

    store.ingestRaw({ envelope: { sourceNumber: ALICE, timestamp: 1810, editMessage: { targetSentTimestamp: sentAt, dataMessage: { timestamp: 1810, message: 'I owe you $500' } } } });
    await settle();
    assert.equal((await db.getMessage(id))!.body, 'see you at 6');

    store.ingestRaw({ envelope: { sourceNumber: ME, timestamp: 1820, syncMessage: { sentMessage: { destinationNumber: ALICE, timestamp: 1820, editMessage: { targetSentTimestamp: sentAt, dataMessage: { timestamp: 1820, message: 'see you at 7' } } } } } });
    await settle();
    const rec = (await db.getMessage(id))!;
    assert.equal(rec.body, 'see you at 7');
    assert.equal(rec.edited, true);
  });

  it('edits a message from its latest text once another device has edited it', async () => {
    (signal as any).send = async () => ({ timestamp: 1900 });
    const sent = await store.sendText(ALICE, 'meet at **6**');
    assert.equal(sent.raw, 'meet at **6**');
    store.ingestRaw({ envelope: { sourceNumber: ME, timestamp: 1910, syncMessage: { sentMessage: { destinationNumber: ALICE, timestamp: 1910, editMessage: { targetSentTimestamp: 1900, dataMessage: { timestamp: 1910, message: 'meet at 7' } } } } } });
    await settle();
    const rec = (await db.getMessage(ALICE + '|1900|' + ME))!;
    assert.equal(rec.body, 'meet at 7');
    assert.equal(rec.raw, undefined);
  });

  it('forwards text with its formatting and an attachment without its mentions', async () => {
    const sent: any[] = [];
    (signal as any).send = async (payload: any) => {
      sent.push(payload);
      return { timestamp: 5050 };
    };
    const src = (await db.getMessage(ALICE + '|1500|' + ALICE))!;
    const fwd = { ...src, body: 'hi @Bob', styles: [{ start: 0, length: 2, style: 'BOLD' }], mentions: [{ name: 'Bob', uuid: 'aci-bob' }], attachments: [{ id: 'x', contentType: 'image/png', filename: 'a.png', size: 3 }] };
    const rec = await store.forwardMessage(ALICE, fwd, ['data:image/png;base64,AAAA']);
    assert.equal(sent[0].message, 'hi @Bob');
    assert.deepEqual(sent[0].styles, [{ start: 0, length: 2, style: 'BOLD' }]);
    assert.equal(sent[0].mentions, undefined);
    assert.deepEqual(sent[0].base64_attachments, ['data:image/png;base64,AAAA']);
    assert.equal(rec.attachments[0].id, '');
    assert.equal(rec.incoming, false);

    const album = { ...src, body: '', attachments: [{ id: 'x', contentType: 'image/png', filename: 'a.png', size: 3, width: 4, height: 4 }, { id: 'y', contentType: 'image/jpeg', filename: 'b.jpg', size: 3 }] };
    const both = await store.forwardMessage(ALICE, album, ['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB']);
    assert.deepEqual(sent[1].base64_attachments, ['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB']);
    assert.deepEqual(sent[1].attachment_meta, [{ width: 4, height: 4 }, null]);
    assert.deepEqual(both.attachments.map((a) => a.filename), ['a.png', 'b.jpg']);
  });

  it('sends with formatting and the chat timer, then tracks receipts', async () => {
    const sent: any[] = [];
    (signal as any).send = async (payload: any) => {
      sent.push(payload);
      return { timestamp: 5000 };
    };
    config.set({ styledText: true });
    store.setConvExpire(ALICE, 3600);
    const rec = await store.sendText(ALICE, 'see **this**');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].message, 'see this');
    assert.deepEqual(sent[0].styles, [{ start: 4, length: 4, style: 'BOLD' }]);
    assert.equal(sent[0].expire_timer, 3600);
    assert.equal(rec.timestamp, 5000);
    assert.equal(rec.status, 'sent');
    assert.equal(rec.raw, 'see **this**');
    assert.ok(rec.expiresAt);

    store.ingestRaw({ envelope: { sourceNumber: ALICE, receiptMessage: { isDelivery: true, timestamps: [5000] } } });
    await settle();
    assert.equal((await db.getMessage(ALICE + '|5000|' + ME))!.status, 'delivered');
    store.ingestRaw({ envelope: { sourceNumber: ALICE, receiptMessage: { isRead: true, timestamps: [5000] } } });
    store.ingestRaw({ envelope: { sourceNumber: ALICE, receiptMessage: { isDelivery: true, timestamps: [5000] } } });
    await settle();
    assert.equal((await db.getMessage(ALICE + '|5000|' + ME))!.status, 'read');
  });

  it('keeps a receipt that arrives before a re-timed send returns, and keeps the message while it moves', async () => {
    let finish: (v: unknown) => void = () => {};
    (signal as any).send = () => new Promise((r) => (finish = r));
    const sending = store.sendText(ALICE, 'retimed');
    await settle();
    const pending = (await db.getMessagesPage(ALICE, Infinity, 50)).find((m) => m.body === 'retimed')!;
    assert.equal(pending.status, 'pending');
    store.ingestRaw({ envelope: { sourceNumber: ALICE, receiptMessage: { isDelivery: true, timestamps: [5300] } } });
    await settle();
    finish({ timestamp: 5300 });
    const rec = await sending;
    await settle();
    assert.equal(rec.status, 'delivered');
    assert.equal((await db.getMessage(ALICE + '|5300|' + ME))!.status, 'delivered');
    assert.equal(await db.getMessage(pending.id), undefined);
  });

  it('starts the default timer on the first message to a new chat and keeps private delivery', async () => {
    const sent: any[] = [];
    const timers: Array<[string, number]> = [];
    (signal as any).setDirectExpireTimer = async (sendId: string, secs: number) => {
      timers.push([sendId, secs]);
    };
    (signal as any).send = async (payload: any) => {
      sent.push(payload);
      return { timestamp: 5060 + sent.length, sealed: true };
    };
    config.set({ defaultExpireTimer: 86400 });
    const conv = store.conversationWith({ number: '+15550009' });
    const rec = await store.sendText(conv.id, 'first');
    await store.sendText(conv.id, 'second');
    config.set({ defaultExpireTimer: 0 });
    assert.deepEqual(timers, [[conv.sendId, 86400]]);
    assert.equal(sent[0].expire_timer, 86400);
    assert.equal(sent[1].expire_timer, 86400);
    assert.equal(store.conversation(conv.id)!.expireTimer, 86400);
    assert.equal(rec.sealed, true);
    assert.equal((await db.getMessage(rec.id))!.sealed, true);
    (signal as any).sendDeleteForMe = async () => {};
    await store.deleteChat(conv.id);

    store.ingestRaw({ envelope: { sourceNumber: ALICE, sealed: true, timestamp: 1800, dataMessage: { timestamp: 1800, message: 'quiet' } } });
    store.ingestRaw(incoming(1900, 'loud'));
    await settle();
    assert.equal((await db.getMessage(ALICE + '|1800|' + ALICE))!.sealed, true);
    assert.equal((await db.getMessage(ALICE + '|1900|' + ALICE))!.sealed, undefined);
  });

  it('sends picked mentions and quoted attachment types, and keeps them for a retry', async () => {
    const sent: any[] = [];
    (signal as any).send = async (payload: any) => {
      sent.push(payload);
      return { timestamp: 5100 };
    };
    const quote = { author: ALICE, timestamp: 1000, text: '', attachments: [{ contentType: 'image/jpeg', filename: 'a.jpg' }] };
    const rec = await store.sendText(ALICE, 'hey @Bob', quote, [{ name: 'Bob', uuid: 'aci-bob' }]);
    assert.equal(sent[0].message, 'hey \uFFFC');
    assert.deepEqual(sent[0].mentions, [{ start: 4, length: 1, uuid: 'aci-bob' }]);
    assert.deepEqual(sent[0].quote_attachments, [{ contentType: 'image/jpeg', filename: 'a.jpg' }]);
    assert.equal(rec.body, 'hey @Bob');
    assert.deepEqual(rec.mentions, [{ name: 'Bob', uuid: 'aci-bob' }]);
  });

  it('searches the newest messages first and stops at the limit, also in a database from before the time index', async () => {
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(db.nameFor('search-v4'), 4);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('messages', { keyPath: 'id' }).createIndex('conv', ['convId', 'timestamp'], { unique: false });
        for (const n of ['conversations', 'contacts', 'attachments']) req.result.createObjectStore(n, { keyPath: 'id' });
        req.result.createObjectStore('kv', { keyPath: 'k' });
        for (const n of ['signal_keystore']) req.result.createObjectStore(n, { keyPath: 'k' });
        for (const n of ['signal_identities', 'signal_sessions']) req.result.createObjectStore(n, { keyPath: 'address' });
        for (const n of ['signal_prekeys', 'signal_sender_keys']) req.result.createObjectStore(n, { keyPath: 'id' });
        for (let i = 1; i <= 5; i++) req.transaction!.objectStore('messages').put({ id: 'm' + i, convId: 'c', timestamp: i * 1000, body: 'needle ' + i, author: ALICE, incoming: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    old.close();
    await db.useAccount('search-v4');
    try {
      assert.deepEqual((await db.searchMessages('NEEDLE', 2)).map((m) => m.id), ['m5', 'm4']);
      assert.deepEqual((await db.searchMessages('needle 1')).map((m) => m.id), ['m1']);
      const upgraded = await new Promise<IDBDatabase>((resolve) => {
        const req = indexedDB.open(db.nameFor('search-v4'));
        req.onsuccess = () => resolve(req.result);
      });
      assert.ok(upgraded.transaction('messages').objectStore('messages').indexNames.contains('ts'));
      upgraded.close();
    } finally {
      await db.useAccount(null);
    }
  });

  it('knows when we’re no longer in a group, but not before its state arrives', () => {
    const g = (members: string[], masterKey = 'mk') => ({ id: 'group.x', internal_id: 'x', masterKey, members }) as any;
    assert.equal(outOfGroup(g(['aci-bob', 'aci-carol'])), true);
    assert.equal(outOfGroup(g(['aci-bob', 'aci-me'])), false);
    assert.equal(outOfGroup(g([], '')), false);
    assert.equal(outOfGroup(g([])), false);
    assert.equal(outOfGroup(null), false);
  });

  it('calls someone known only by their Signal ID “Unknown”', () => {
    assert.equal(store.displayName('8a1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'), S.unknown);
    assert.equal(store.displayName('PNI:8a1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'), S.unknown);
    assert.equal(store.displayName('+15550009999'), '+15550009999');
  });

  it('remembers group members a message couldn’t reach', async () => {
    (signal as any).send = async () => ({ timestamp: 5150, notDelivered: 2 });
    const rec = await store.sendText(ALICE, 'to most of you');
    assert.equal(rec.status, 'sent');
    assert.equal(rec.notDelivered, 2);
    assert.equal((await db.getMessage(rec.id))!.notDelivered, 2);
    (signal as any).send = async () => ({ timestamp: 5160 });
    assert.equal((await store.sendText(ALICE, 'to all')).notDelivered, undefined);
  });

  it('keeps mentions in a photo’s caption', async () => {
    const sent: any[] = [];
    (signal as any).send = async (payload: any) => {
      sent.push(payload);
      return { timestamp: 5200 };
    };
    const rec = await store.sendAttachments(ALICE, [{ dataUri: 'data:image/jpeg;base64,AAAA', contentType: 'image/jpeg' }], 'for @Bob', { mentions: [{ name: 'Bob', uuid: 'aci-bob' }] });
    assert.equal(sent[0].message, 'for \uFFFC');
    assert.deepEqual(sent[0].mentions, [{ start: 4, length: 1, uuid: 'aci-bob' }]);
    assert.equal(rec.body, 'for @Bob');
    assert.deepEqual(rec.mentions, [{ name: 'Bob', uuid: 'aci-bob' }]);
  });

  it('forwards at most 32 attachments', async () => {
    const sent: any[] = [];
    (signal as any).send = async (payload: any) => {
      sent.push(payload);
      return { timestamp: 5300 };
    };
    const many = Array.from({ length: 40 }, (_, i) => ({ id: 'p' + i, contentType: 'image/jpeg', filename: i + '.jpg', size: 3 }));
    const src = { id: 'fwd-many', convId: ALICE, author: ALICE, timestamp: 900, body: '', attachments: many, incoming: true } as any;
    const rec = await store.forwardMessage(ALICE, src, many.map(() => 'data:image/jpeg;base64,AAAA'));
    assert.equal(sent[0].base64_attachments.length, store.MAX_ATTACHMENTS);
    assert.equal(rec.attachments.length, store.MAX_ATTACHMENTS);
  });

  it('sends a link preview only for a link that is in the message', async () => {
    const sent: any[] = [];
    (signal as any).send = async (payload: any) => {
      sent.push(payload);
      return { timestamp: 5200 };
    };
    const preview = { url: 'https://signal.org/blog', title: 'Signal Blog', description: 'News', date: 1700000000000, image: { data: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' } };
    const rec = await store.sendText(ALICE, 'read https://signal.org/blog.', null, [], preview);
    assert.deepEqual(sent[0].preview, { url: 'https://signal.org/blog', title: 'Signal Blog', description: 'News', date: 1700000000000, image: 'data:image/jpeg;base64,AQID' });
    assert.deepEqual(rec.preview, { url: 'https://signal.org/blog', title: 'Signal Blog', description: 'News' });
    await store.sendText(ALICE, 'no link here', null, [], preview);
    assert.equal(sent[1].preview, undefined);
  });

  it('keeps a chat draft until it is cleared', () => {
    store.setDraft(ALICE, 'half a thought', [{ name: 'Bob', uuid: 'aci-bob' }]);
    assert.equal(store.conversation(ALICE)!.draft, 'half a thought');
    assert.deepEqual(store.conversation(ALICE)!.draftMentions, [{ name: 'Bob', uuid: 'aci-bob' }]);
    store.setDraft(ALICE, '   ', []);
    assert.equal(store.conversation(ALICE)!.draft, undefined);
    assert.equal(store.conversation(ALICE)!.draftMentions, undefined);
  });

  it('marks a failed send and clears unread from another device', async () => {
    (signal as any).send = async () => {
      throw new Error('offline');
    };
    await assert.rejects(store.sendText(ALICE, 'nope'));
    await settle();
    const page = await db.getMessagesPage(ALICE, Number.MAX_SAFE_INTEGER, 10);
    assert.equal(page[page.length - 1].status, 'failed');

    store.ingestRaw({ envelope: { sourceNumber: ME, syncMessage: { readMessages: [{ senderNumber: ALICE, timestamp: 1000 }] } } });
    await settle();
    assert.equal(store.conversation(ALICE)!.unread, 3, 'messages after the read one stay unread');
    store.ingestRaw({ envelope: { sourceNumber: ME, syncMessage: { readMessages: [{ senderNumber: ALICE, timestamp: 1900 }] } } });
    await settle();
    assert.equal(store.conversation(ALICE)!.unread, 0);
  });

  it('stores a missed call as an unread notice line', async () => {
    const before = store.conversation(ALICE)!.unread;
    const ts = Date.now() + 60000;
    store.ingestRaw({ envelope: { sourceNumber: ALICE, timestamp: ts, notice: { kind: 'missedCall', timestamp: ts } } });
    await settle();
    const rec = (await db.getMessage(ALICE + '|' + ts + '|' + ALICE))!;
    assert.deepEqual(rec.notice, { kind: 'missedCall' });
    assert.equal(rec.body, '');
    const conv = store.conversation(ALICE)!;
    assert.equal(conv.unread, before + 1);
    assert.equal(conv.lastPreview, 'Voice call');
  });

  it('notifies for payments and story reactions from others, but not for our own from another device', async () => {
    const unread = store.conversation(ALICE)!.unread;
    const ts = Date.now() + 61000;
    store.ingestRaw({ envelope: { sourceNumber: ALICE, timestamp: ts, dataMessage: { timestamp: ts, payment: { kind: 'notification' } } } });
    await settle();
    assert.equal(store.conversation(ALICE)!.lastPreview, 'Alice sent you a payment. Check your main phone to see it.');
    store.ingestRaw({ envelope: { sourceNumber: ALICE, timestamp: ts + 1, dataMessage: { timestamp: ts + 1, reaction: { emoji: '❤️' }, storyContext: { authorUuid: 'aci-me', sentTimestamp: 5 } } } });
    await settle();
    assert.equal(store.conversation(ALICE)!.lastPreview, 'Alice reacted ❤️ to your story');
    assert.equal(store.conversation(ALICE)!.unread, unread + 2);

    store.ingestRaw({ envelope: { sourceNumber: ME, timestamp: ts + 2, syncMessage: { sentMessage: { destinationNumber: ALICE, timestamp: ts + 2, payment: { kind: 'notification' } } } } });
    await settle();
    assert.equal(store.conversation(ALICE)!.lastPreview, 'You sent a payment. Check your main phone to see it.');
    assert.equal(store.conversation(ALICE)!.unread, unread + 2);
    assert.equal(store.noticeText({ kind: 'payment', value: 'activationRequest' }, ALICE), 'Alice asked you to turn on payments, which you can do on your main phone.');
    assert.equal(store.noticeText({ kind: 'storyReaction', text: '👍' }, ME), 'You reacted 👍 to their story');
  });

  it('adds safety number notices only to existing chats, without counting them unread', async () => {
    const unread = store.conversation(ALICE)!.unread;
    store.ingestRaw({ envelope: { sourceNumber: ALICE, timestamp: 5600, safetyNumberChanged: true, receiptMessage: { isDelivery: true, timestamps: [] } } });
    store.ingestRaw({ envelope: { sourceNumber: '+15550077', timestamp: 5600, safetyNumberChanged: true, receiptMessage: { isDelivery: true, timestamps: [] } } });
    await settle();
    const rec = (await db.getMessage(ALICE + '|5599|' + ALICE))!;
    assert.deepEqual(rec.notice, { kind: 'safetyNumber' });
    assert.equal(store.conversation(ALICE)!.unread, unread);
    assert.equal(store.conversation('+15550077'), undefined);
    assert.equal(store.noticeText({ kind: 'safetyNumber' }, ALICE), 'Your safety number with Alice has changed');
  });

  it('archives, keeps muted chats archived, and limits pinned chats', async () => {
    (signal as any).syncChatState = async () => {};
    store.setArchived(ALICE, true);
    store.setMuted(ALICE, store.MUTED_ALWAYS);
    assert.deepEqual(store.conversations(), []);
    store.ingestRaw(incoming(6000, 'still archived'));
    await settle();
    assert.equal(store.archivedConversations().length, 1);

    store.setMuted(ALICE, 0);
    store.ingestRaw(incoming(7000, 'back'));
    await settle();
    assert.equal(store.conversations().length, 1);

    for (let i = 0; i < store.MAX_PINNED_CHATS; i++) {
      const c = store.conversationWith({ number: '+1555100' + i });
      assert.equal(store.setConvPinned(c.id, true), true);
    }
    assert.equal(store.setConvPinned(ALICE, true), false);

    const first = store.conversationWith({ number: '+15551000' });
    store.setArchived(first.id, true);
    assert.equal(store.conversation(first.id)!.pinned, false, 'archiving unpins');
    assert.equal(store.setConvPinned(ALICE, true), true, 'the freed slot can be used');
    store.setArchived(first.id, false);
  });

  it('mutes a chat until a time, publishes it, and refreshes the list when the mute runs out', async () => {
    const synced: any[] = [];
    (signal as any).syncChatState = async (s: any) => {
      synced.push(s);
    };
    const conv = store.conversation(ALICE)!;
    const until = Date.now() + 80;
    store.setMuted(ALICE, until);
    assert.equal(store.isMuted(conv), true);
    assert.equal(store.mutedForever(conv), false);
    assert.equal(synced[synced.length - 1].mutedUntil, until);
    let refreshed = 0;
    const off = store.on('conversations', () => refreshed++);
    await new Promise((r) => setTimeout(r, 700));
    off();
    assert.equal(store.isMuted(conv), false);
    assert.ok(refreshed >= 1);

    store.applyChatState([{ number: ALICE, archived: false, mutedUntil: 9.2e18 }], null);
    assert.equal(store.mutedForever(conv), true);
    store.applyChatState([{ number: ALICE, archived: false, mutedUntil: 0 }], null);
    assert.equal(store.isMuted(conv), false);

    const legacy: any = { id: 'x', muted: true };
    assert.equal(migrateMute(legacy), true);
    assert.deepEqual({ ...legacy }, { id: 'x', mutedUntil: MUTED_ALWAYS });
    const unmuted: any = { id: 'y', muted: false };
    migrateMute(unmuted);
    assert.equal(store.isMuted(unmuted), false);
    assert.equal(migrateMute(legacy), false);
  });

  it('marks a chat unread, syncs it, and clears it when the chat is read', () => {
    const synced: any[] = [];
    (signal as any).syncChatState = async (s: any) => {
      synced.push(s);
    };
    (signal as any).sendReadReceipts = async () => {};
    store.markRead(ALICE);
    synced.length = 0;
    store.setMarkedUnread(ALICE, true);
    assert.equal(store.conversation(ALICE)!.markedUnread, true);
    assert.deepEqual(synced, [{ type: 'direct', sendId: ALICE, markedUnread: true }]);
    store.markRead(ALICE);
    assert.equal(store.conversation(ALICE)!.markedUnread, false);
    assert.deepEqual(synced[1], { type: 'direct', sendId: ALICE, markedUnread: false });
    store.applyChatState([{ number: ALICE, archived: false, markedUnread: true }], null);
    assert.equal(store.conversation(ALICE)!.markedUnread, true);
    assert.equal(synced.length, 2);
  });

  it('sends view-once media without a caption', async () => {
    const sent: any[] = [];
    (signal as any).send = async (payload: any) => {
      sent.push(payload);
      return { timestamp: 8000 };
    };
    const rec = await store.sendAttachments(ALICE, [{ dataUri: 'data:image/jpeg;base64,AAAA', contentType: 'image/jpeg' }], 'a caption', { viewOnce: true });
    assert.equal(sent[0].view_once, true);
    assert.equal(sent[0].message, '');
    assert.equal(rec.body, '');
    assert.equal(rec.attachments[0].viewOnce, true);
    await assert.rejects(store.sendAttachments(ALICE, [{ dataUri: 'data:image/jpeg;base64,AAAA' }, { dataUri: 'data:image/jpeg;base64,BBBB' }], '', { viewOnce: true }));
  });

  it('sends several attachments in one message, in order, with the caption and quote', async () => {
    const sent: any[] = [];
    (signal as any).send = async (payload: any) => {
      sent.push(payload);
      return { timestamp: 8100 };
    };
    const files = [
      { dataUri: 'data:image/jpeg;base64,AAAA', contentType: 'image/jpeg', filename: 'a.jpg', size: 3 },
      { dataUri: 'data:image/png;base64,BBBB', contentType: 'image/png', filename: 'b.png', size: 3 },
      { dataUri: 'data:application/pdf;base64,CCCC', contentType: 'application/pdf', filename: 'c.pdf', size: 3 },
    ];
    const rec = await store.sendAttachments(ALICE, files, 'trip', { quote: { author: ALICE, timestamp: 1000, text: 'pics?' } });
    assert.deepEqual(sent[0].base64_attachments, files.map((f) => f.dataUri));
    assert.equal(sent[0].message, 'trip');
    assert.equal(sent[0].quote_timestamp, 1000);
    assert.deepEqual(rec.attachments.map((a) => a.filename), ['a.jpg', 'b.png', 'c.pdf']);
    assert.equal((await db.getMessage(rec.id))!.attachments.length, 3);
    assert.equal(store.attachmentLabel(rec.attachments), '3 attachments');
    assert.equal(store.attachmentLabel(rec.attachments.slice(0, 2)), '2 photos');
    await assert.rejects(store.sendAttachments(ALICE, Array.from({ length: store.MAX_ATTACHMENTS + 1 }, () => files[0]), ''));
    assert.equal(sent[1], undefined);
    assert.equal(sent[0].attachment_meta, undefined);
  });

  it('sends a recorded voice message with its waveform and length, and keeps them on received ones', async () => {
    const sent: any[] = [];
    (signal as any).send = async (payload: any) => {
      sent.push(payload);
      return { timestamp: 8200 };
    };
    const rec = await store.sendAttachments(ALICE, [{ dataUri: 'data:audio/mpeg;base64,AAAA', contentType: 'audio/mpeg', filename: '', size: 3, voiceNote: true, waveform: [10, 200], duration: 4.2 }], '');
    assert.deepEqual(sent[0].attachment_meta, [{ voice: true, waveform: [10, 200], duration: 4.2 }]);
    assert.equal(rec.attachments[0].filename, '');
    assert.deepEqual(rec.attachments[0].waveform, [10, 200]);
    assert.equal(rec.attachments[0].duration, 4.2);
    assert.equal(store.attachmentLabel(rec.attachments), 'Voice message');

    store.ingestRaw(incoming(8300, '', { attachments: [{ id: 'att-wave', contentType: 'audio/mpeg', voiceNote: true, waveform: new Array(150).fill(300), duration: 9.5 }] }));
    await settle();
    const got = (await db.getMessage(ALICE + '|8300|' + ALICE))!.attachments[0];
    assert.equal(got.waveform!.length, 100);
    assert.ok(got.waveform!.every((v) => v === 255));
    assert.equal(got.duration, 9.5);
  });

  it('reports opened media once and drops view-once copies opened on another device', async () => {
    const viewed: any[] = [];
    (signal as any).sendViewed = async (to: string, ts: number, opts: any) => {
      viewed.push([to, ts, opts]);
    };
    const cleared: Array<[string, number]> = [];
    const putAttachment = db.putAttachment;
    (db as any).putAttachment = async (id: string, blob: Blob) => {
      cleared.push([id, blob.size]);
    };
    try {
      store.ingestRaw(incoming(9000, '', { attachments: [{ id: 'att-voice', contentType: 'audio/aac', voiceNote: true }] }));
      store.ingestRaw(incoming(9100, '', { attachments: [{ id: 'att-once', contentType: 'image/jpeg' }], viewOnce: true }));
      store.ingestRaw(incoming(9200, '', { attachments: [{ id: 'att-photo', contentType: 'image/jpeg' }] }));
      await settle();
      const voice = (await db.getMessage(ALICE + '|9000|' + ALICE))!;
      store.markViewed(voice);
      store.markViewed(voice);
      store.markViewed((await db.getMessage(ALICE + '|9200|' + ALICE))!);
      await settle();
      assert.deepEqual(viewed, [[ALICE, 9000, { receipt: true, viewOnce: false }]]);
      assert.equal((await db.getMessage(ALICE + '|9000|' + ALICE))!.viewed, true);

      store.ingestRaw({ envelope: { sourceNumber: ME, syncMessage: { viewOnceOpen: { senderNumber: ALICE, timestamp: 9100 } } } });
      await settle();
      assert.equal((await db.getMessage(ALICE + '|9100|' + ALICE))!.viewed, true);
      assert.deepEqual(cleared, [['att-once', 0]]);
    } finally {
      (db as any).putAttachment = putAttachment;
    }
  });

  it('marks view-once media as viewed when it’s shown, not when it downloads', async () => {
    (signal as any).downloadAttachmentBlob = async () => new Blob(['secret']);
    (signal as any).sendViewed = async () => {};
    store.ingestRaw(incoming(9150, '', { attachments: [{ id: 'att-once-late', contentType: 'image/jpeg' }], viewOnce: true }));
    await settle();
    const rec = (await db.getMessage(ALICE + '|9150|' + ALICE))!;
    assert.equal((await loadAttachment(rec.attachments[0])).size, 6);
    await settle();
    assert.equal(await db.getAttachment('att-once-late'), undefined, 'leaving before it shows leaves it to open later');
    assert.equal((await loadAttachment(rec.attachments[0])).size, 6);
    store.markViewed(rec);
    await settle();
    await assert.rejects(loadAttachment(rec.attachments[0]), (e: unknown) => e instanceof ViewedOnceError);
  });

  it('lists a chat’s media newest first without view-once or unsaved sends', async () => {
    const media = await store.chatMedia(ALICE);
    const ids = media.map((x) => x.att.id);
    assert.deepEqual(ids.slice(0, 2), ['att-photo', 'att-voice']);
    assert.equal(ids.indexOf('att-once'), -1);
    assert.equal(ids.indexOf(''), -1);
    assert.equal(media[0].msg.timestamp, 9200);
    assert.deepEqual((await store.chatMedia(ALICE, 1)).map((x) => x.att.id), ['att-photo']);
  });

  it('syncs a delete for me and applies one from another device', async () => {
    const synced: any[] = [];
    (signal as any).sendDeleteForMe = async (body: any) => {
      synced.push(body);
    };
    store.ingestRaw(incoming(20000, 'one'));
    store.ingestRaw(incoming(20100, 'two'));
    await settle();
    await store.deleteLocal((await db.getMessage(ALICE + '|20000|' + ALICE))!);
    assert.deepEqual(synced, [{ messages: [{ chat: ALICE, items: [{ author: ALICE, timestamp: 20000 }] }] }]);

    store.ingestRaw({ envelope: { sourceNumber: ME, syncMessage: { deleteForMe: { messages: [{ conversation: { number: ALICE }, messages: [{ author: ALICE, timestamp: 20100 }] }] } } } });
    await settle();
    assert.equal(await db.getMessage(ALICE + '|20100|' + ALICE), undefined);
  });

  it('deletes a chat with its newest messages named, and applies chat deletes up to the newest one listed', async () => {
    const BOB = '+15550002';
    const CAROL = '+15550003';
    const from = (src: string, ts: number, body: string) => ({ envelope: { sourceNumber: src, timestamp: ts, dataMessage: { timestamp: ts, message: body } } });
    const synced: any[] = [];
    (signal as any).sendDeleteForMe = async (body: any) => {
      synced.push(body);
    };
    for (let i = 0; i < 7; i++) store.ingestRaw(from(BOB, 30000 + i, 'b' + i));
    await settle();
    await store.deleteChat(BOB);
    assert.equal(store.conversation(BOB), undefined);
    assert.equal((await db.getMessagesPage(BOB, Number.MAX_SAFE_INTEGER, 10)).length, 0);
    const chat = synced[0].chats[0];
    assert.equal(chat.chat, BOB);
    assert.deepEqual(
      chat.mostRecent.map((r: any) => r.timestamp),
      [30006, 30005, 30004, 30003, 30002]
    );

    store.ingestRaw(from(CAROL, 40000, 'c1'));
    store.ingestRaw(from(CAROL, 40100, 'c2'));
    store.ingestRaw(from(CAROL, 40200, 'c3'));
    await settle();
    const chatDelete = (ts: number) => ({ envelope: { sourceNumber: ME, syncMessage: { deleteForMe: { conversations: [{ conversation: { number: CAROL }, mostRecent: [{ author: CAROL, timestamp: ts }], isFullDelete: true }] } } } });
    store.ingestRaw(chatDelete(40100));
    await settle();
    assert.deepEqual(
      (await db.getMessagesPage(CAROL, Number.MAX_SAFE_INTEGER, 10)).map((m) => m.body),
      ['c3']
    );
    assert.equal(store.conversation(CAROL)!.lastPreview, 'c3');
    store.ingestRaw(chatDelete(40200));
    await settle();
    assert.equal(store.conversation(CAROL), undefined);
  });

  it('takes a chat’s timer only from a newer timer version, and never from a group message', async () => {
    const PEER = '+15550077';
    const at = Date.now();
    const dm = (n: number, extra: any) => ({ envelope: { sourceNumber: PEER, timestamp: at + n, dataMessage: { timestamp: at + n, message: 'm' + n, ...extra } } });
    store.ingestRaw(dm(1, { expiresInSeconds: 3600, expireTimerVersion: 2 }));
    await settle();
    assert.equal(store.conversation(PEER)!.expireTimer, 3600);
    store.ingestRaw(dm(2, { expiresInSeconds: 0, expireTimerVersion: 1 }));
    store.ingestRaw(dm(3, { expiresInSeconds: 0 }));
    await settle();
    assert.equal(store.conversation(PEER)!.expireTimer, 3600, 'an older version or none leaves it');
    store.ingestRaw(dm(4, { expiresInSeconds: 60, expireTimerVersion: 3 }));
    await settle();
    assert.equal(store.conversation(PEER)!.expireTimer, 60);
    store.ingestRaw(dm(5, { expirationTimerUpdate: true, expiresInSeconds: 0, expireTimerVersion: 2 }));
    await settle();
    assert.equal(store.conversation(PEER)!.expireTimer, 60, 'an older timer update is ignored too');

    await db.kvSet('syncedGroups', [{ id: 'group.VElN', internal_id: 'VElN', masterKey: '', revision: 1, name: 'Timers', members: ['aci-dave'], admins: [], pending: [], expireTimer: 86400, blocked: false, link_mode: 'disabled', invite_link: '' }]);
    await store.refreshDirectory();
    const inGroup = (n: number, secs: number) => ({ envelope: { sourceNumber: '+15550004', sourceUuid: 'aci-dave', timestamp: at + n, dataMessage: { timestamp: at + n, groupInfo: { groupId: 'VElN' }, message: 'g' + n, expiresInSeconds: secs } } });
    store.ingestRaw(inGroup(6, 86400));
    await settle();
    const before = store.conversation('g:VElN')!.expireTimer;
    store.ingestRaw(inGroup(7, 0));
    await settle();
    assert.equal(store.conversation('g:VElN')!.expireTimer, before, 'a group’s timer comes from its state');
  });

  it('applies admin deletes only from people the group lists as admins', async () => {
    await db.kvSet('syncedContacts', [{ uuid: 'aci-dave', number: '+15550004', name: 'Dave' }]);
    await db.kvSet('syncedGroups', [{ id: 'group.R1JQ', internal_id: 'R1JQ', masterKey: '', revision: 1, name: 'Team', members: ['aci-admin', 'aci-dave'], admins: ['aci-admin'], pending: [], expireTimer: 0, blocked: false, link_mode: 'disabled', invite_link: '' }]);
    await store.refreshDirectory();
    const ts = Date.now();
    const inGroup = (src: string, uuid: string, at: number, dm: any) => ({ envelope: { sourceNumber: src, sourceUuid: uuid, timestamp: at, dataMessage: { timestamp: at, groupInfo: { groupId: 'R1JQ' }, ...dm } } });
    store.ingestRaw(inGroup('+15550004', 'aci-dave', ts, { message: 'oops' }));
    await settle();
    const id = 'g:R1JQ|' + ts + '|+15550004';
    const target = { adminDelete: { targetAuthorUuid: 'aci-dave', targetSentTimestamp: ts } };
    store.ingestRaw(inGroup('+15550004', 'aci-dave', ts + 1, target));
    await settle();
    assert.equal((await db.getMessage(id))!.deleted, false);

    store.ingestRaw(inGroup('+15550005', 'aci-admin', ts + 2, target));
    await settle();
    const rec = (await db.getMessage(id))!;
    assert.equal(rec.deleted, true);
    assert.equal(rec.deletedByAdmin, true);
    assert.equal(rec.body, '');
    assert.equal(store.conversation('g:R1JQ')!.lastPreview, 'An admin deleted this message.');
  });

  it('counts poll votes like Signal-Desktop and lets only the author end the poll', async () => {
    const ts = Date.now() + 1000;
    const inGroup = (src: string, uuid: string, at: number, dm: any) => ({ envelope: { sourceNumber: src, sourceUuid: uuid, timestamp: at, dataMessage: { timestamp: at, groupInfo: { groupId: 'R1JQ' }, ...dm } } });
    const vote = (src: string, uuid: string, at: number, optionIndexes: number[], voteCount: number) => inGroup(src, uuid, at, { pollVote: { targetAuthorUuid: 'aci-dave', targetSentTimestamp: ts, optionIndexes, voteCount } });
    const id = 'g:R1JQ|' + ts + '|+15550004';
    store.ingestRaw(inGroup('+15550004', 'aci-dave', ts, { pollCreate: { question: 'Lunch?', options: ['Pizza', 'Soup', 'Salad'], allowMultiple: false } }));
    await settle();
    assert.equal(store.conversation('g:R1JQ')!.lastPreview, 'Poll: Lunch?');

    store.ingestRaw(vote('+15550005', 'aci-admin', ts + 1, [1], 2));
    store.ingestRaw(vote('+15550005', 'aci-admin', ts + 2, [0], 1));
    store.ingestRaw(vote('+15550005', 'aci-admin', ts + 3, [0, 2], 3));
    store.ingestRaw(vote('+15550005', 'aci-admin', ts + 4, [5], 4));
    store.ingestRaw({ envelope: { sourceNumber: ME, sourceUuid: 'aci-me', timestamp: ts + 5, syncMessage: { sentMessage: { timestamp: ts + 5, groupInfo: { groupId: 'R1JQ' }, pollVote: { targetAuthorUuid: 'aci-dave', targetSentTimestamp: ts, optionIndexes: [2], voteCount: 1 } } } } });
    await settle();
    let rec = (await db.getMessage(id))!;
    assert.deepEqual(rec.poll!.votes['+15550005'].options, [1]);
    assert.deepEqual(store.pollCounts(rec.poll!), [0, 1, 1]);

    const sent: any[] = [];
    (signal as any).sendPollVote = async (...args: any[]) => {
      sent.push(args);
    };
    await store.votePoll(rec, [0]);
    assert.deepEqual(sent, [['group.R1JQ', '+15550004', ts, [0], 2]]);
    rec = (await db.getMessage(id))!;
    assert.deepEqual(rec.poll!.votes[ME], { options: [0], voteCount: 2, timestamp: rec.poll!.votes[ME].timestamp });

    store.ingestRaw(inGroup('+15550005', 'aci-admin', ts + 6, { pollTerminate: { targetSentTimestamp: ts } }));
    await settle();
    assert.equal((await db.getMessage(id))!.poll!.ended, undefined);
    store.ingestRaw(inGroup('+15550004', 'aci-dave', ts + 7, { pollTerminate: { targetSentTimestamp: ts } }));
    store.ingestRaw(vote('+15550005', 'aci-admin', ts + 8, [2], 9));
    await settle();
    rec = (await db.getMessage(id))!;
    assert.equal(rec.poll!.ended, true);
    assert.deepEqual(rec.poll!.votes['+15550005'].options, [1]);
    const line = (await db.getMessage('g:R1JQ|' + (ts + 7) + '|+15550004'))!;
    assert.equal(store.noticeText(line.notice!, line.author), 'Dave ended the poll “Lunch?”');
  });

  it('sends, votes in, and ends a poll in a one-to-one chat', async () => {
    const sent: any[] = [];
    (signal as any).send = async (payload: any) => {
      sent.push(payload);
      return { timestamp: 7100 };
    };
    const votes: any[] = [];
    (signal as any).sendPollVote = async (...args: any[]) => {
      votes.push(args);
    };
    (signal as any).sendPollTerminate = async () => 7200;
    const rec = await store.sendPoll(ALICE, 'Tea?', ['Yes', 'No'], false);
    assert.deepEqual(sent[0].poll, { question: 'Tea?', options: ['Yes', 'No'], allow_multiple: false });
    assert.deepEqual(sent[0].recipients, [ALICE]);
    await store.votePoll(rec, [1]);
    assert.deepEqual(votes[0].slice(0, 4), [ALICE, ME, rec.timestamp, [1]]);
    const voteFrom = (src: string, at: number) => ({ envelope: { sourceNumber: src, timestamp: at, dataMessage: { timestamp: at, pollVote: { targetAuthorUuid: 'aci-me', targetSentTimestamp: rec.timestamp, optionIndexes: [0], voteCount: 1 } } } });
    store.ingestRaw(voteFrom(ALICE, 7150));
    store.ingestRaw(voteFrom('+15550002', 7160));
    await settle();
    const voted = (await db.getMessage(rec.id))!.poll!;
    assert.deepEqual(voted.votes[ALICE].options, [0], 'their vote counts');
    assert.equal(voted.votes['+15550002'], undefined, 'someone outside the chat can’t vote');
    assert.deepEqual(store.pollCounts(voted), [1, 1]);
    await store.endPoll(rec);
    await settle();
    assert.equal((await db.getMessage(rec.id))!.poll!.ended, true);
  });

  it('shows group changes and timer changes as lines that don’t count as unread', async () => {
    const ts = Date.now() + 5000;
    const before = store.conversation('g:R1JQ')!.unread;
    store.ingestRaw({
      envelope: {
        groupUpdate: {
          groupId: 'R1JQ',
          author: 'aci-dave',
          timestamp: ts,
          changes: [
            { change: 'title', text: 'Team 2' },
            { change: 'memberAdded', target: 'aci-me' },
            { change: 'adminAdded', target: 'aci-admin' },
            { change: 'invited', count: 3 },
            { change: 'link', value: 'enabled-with-approval', from: 'enabled' },
            { change: 'bogus' },
          ],
        },
      },
    });
    store.ingestRaw({ envelope: { groupUpdate: { groupId: 'R1JQ', author: '', timestamp: ts + 10, changes: [{ change: 'timer', seconds: 3600 }, { change: 'requested', target: 'aci-dave' }] } } });
    await settle();
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = (await db.getMessage('g:R1JQ|' + (ts + i) + '|aci-dave'))!;
      lines.push(store.noticeText(m.notice!, m.author));
    }
    for (let i = 0; i < 2; i++) {
      const m = (await db.getMessage('g:R1JQ|' + (ts + 10 + i) + '|'))!;
      lines.push(store.noticeText(m.notice!, m.author));
    }
    assert.deepEqual(lines, [
      'Dave changed the group name to “Team 2”',
      'Dave added you',
      'Dave made aci-admin an admin',
      'Dave invited 3 people to the group',
      'Dave turned on admin approval for the group link',
      'The disappearing message time was set to 1 hour',
      'Dave asked to join via the group link',
    ]);
    assert.equal(store.conversation('g:R1JQ')!.unread, before);
    assert.equal(store.conversation('g:R1JQ')!.lastPreview, 'Dave asked to join via the group link');
    assert.equal(await db.getMessage('g:R1JQ|' + (ts + 5) + '|aci-dave'), undefined);

    store.ingestRaw(incoming(ts + 20, '', { expirationTimerUpdate: true, expiresInSeconds: 604800 }));
    await settle();
    const timer = (await db.getMessage(ALICE + '|' + (ts + 20) + '|' + ALICE))!;
    assert.equal(store.noticeText(timer.notice!, timer.author), 'Alice set the disappearing message time to 1 week');
    assert.equal(store.conversation(ALICE)!.expireTimer, 604800);
    const t0 = Date.now();
    store.setConvExpire(ALICE, 0);
    store.setConvExpire(ALICE, 0);
    await settle();
    const page = await db.getMessagesPage(ALICE, Number.MAX_SAFE_INTEGER, 50);
    const mine = page.filter((m) => m.notice && m.notice.kind === 'timer' && m.author !== ALICE && m.timestamp >= t0);
    assert.deepEqual(mine.map((m) => store.noticeText(m.notice!, m.author)), ['You turned off disappearing messages']);
  });

  it('holds a stranger’s chat as a message request, without read receipts, until it is accepted', async () => {
    const ERIN = '+15550006';
    const receipts: any[] = [];
    const responses: any[] = [];
    (signal as any).sendReadReceipts = async (to: string, ts: number[]) => {
      for (const t of ts) receipts.push([to, t]);
    };
    (signal as any).sendMessageRequestResponse = async (to: string, response: string) => {
      responses.push([to, response]);
    };
    store.ingestRaw({ envelope: { sourceNumber: ERIN, timestamp: 50000, dataMessage: { timestamp: 50000, message: 'hi, it’s me' } } });
    await settle();
    assert.equal(store.conversation(ERIN)!.request, true);
    store.markRead(ERIN);
    await settle();
    assert.equal(store.conversation(ERIN)!.unread, 0);
    assert.deepEqual(receipts, []);

    await store.acceptRequest(ERIN);
    await settle();
    assert.deepEqual(responses, [[ERIN, 'accept']]);
    assert.equal(store.conversation(ERIN)!.request, undefined);
    assert.deepEqual(receipts, [[ERIN, 50000]]);
  });

  it('doesn’t read what arrives in a chat left open while Beacon is in the background', async () => {
    const receipts: any[] = [];
    (signal as any).sendReadReceipts = async (to: string, ts: number[]) => {
      for (const t of ts) receipts.push([to, t]);
    };
    store.markRead(ALICE);
    await settle();
    receipts.length = 0;
    const doc = (globalThis as any).document;
    const ts = Math.max(Date.now(), (store.conversation(ALICE)!.lastReadTs || 0) + 1);
    store.setOpenConv(ALICE);
    doc.hidden = true;
    try {
      store.ingestRaw(incoming(ts, 'while you were away'));
      await settle();
      assert.equal(store.conversation(ALICE)!.unread, 1);
      assert.deepEqual(receipts, []);
    } finally {
      doc.hidden = false;
    }
    store.markRead(ALICE);
    await settle();
    assert.equal(store.conversation(ALICE)!.unread, 0);
    assert.deepEqual(receipts, [[ALICE, ts]]);
    store.setOpenConv(null);
  });

  it('sends one batch of read receipts for every unread message, but none for a notice', async () => {
    const PEER = ALICE;
    store.markRead(PEER);
    await settle();
    const at = Math.max(Date.now(), (store.conversation(PEER)!.lastReadTs || 0) + 1);
    const calls: any[] = [];
    (signal as any).sendReadReceipts = async (to: string, ts: number[]) => void calls.push([to, ts]);
    const dm = (n: number, extra: any) => ({ envelope: { sourceNumber: PEER, timestamp: at + n, dataMessage: { timestamp: at + n, message: 'm' + n, ...extra } } });
    for (let n = 1; n <= 12; n++) store.ingestRaw(dm(n, {}));
    store.ingestRaw(dm(13, { expirationTimerUpdate: true, expiresInSeconds: 60, expireTimerVersion: 2 }));
    await settle();
    store.markRead(PEER);
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], PEER);
    assert.deepEqual(calls[0][1], Array.from({ length: 12 }, (_, i) => at + i + 1));
  });

  it('still syncs what we read to our other devices with read receipts off', async () => {
    const reads: any[] = [];
    (signal as any).sendReadReceipts = async (to: string, ts: number[], opts: { receipt: boolean }) => {
      for (const t of ts) reads.push([to, t, opts.receipt]);
    };
    const ts = Math.max(Date.now(), (store.conversation(ALICE)!.lastReadTs || 0) + 1);
    store.ingestRaw(incoming(ts, 'read me'));
    await settle();
    config.set({ sendReadReceipts: false });
    try {
      store.markRead(ALICE);
      await settle();
    } finally {
      config.set({ sendReadReceipts: true });
    }
    assert.deepEqual(reads, [[ALICE, ts, false]]);
  });

  it('holds a group a stranger added us to as a request until we accept or delete it', async () => {
    const group = (internal: string, extra: Record<string, unknown>) => ({ id: 'group.' + internal, internal_id: internal, masterKey: '', revision: 1, name: 'Deals ' + internal, members: ['aci-me', 'aci-zed'], admins: [], pending: [], expireTimer: 0, blocked: false, link_mode: 'disabled', invite_link: '', ...extra });
    await db.kvSet('syncedGroups', [group('R1RQ', { messageRequest: true, addedBy: 'aci-zed' }), group('R1RD', { messageRequest: true })]);
    await store.refreshDirectory();
    const answers: any[] = [];
    (signal as any).answerGroupRequest = async (sendId: string, response: string) => {
      answers.push([sendId, response]);
    };
    for (const g of ['R1RQ', 'R1RD']) store.ingestRaw({ envelope: { sourceNumber: '+15550010', sourceUuid: 'aci-zed', timestamp: 53000, dataMessage: { timestamp: 53000, groupInfo: { groupId: g }, message: 'great offer' } } });
    await settle();
    const conv = store.conversation('g:R1RQ')!;
    assert.equal(conv.request, true);
    assert.equal(store.groupAddedBy(conv), 'aci-zed');
    await store.acceptRequest('g:R1RQ');
    await store.deleteRequest('g:R1RD');
    assert.deepEqual(answers, [['group.R1RQ', 'accept'], ['group.R1RD', 'delete']]);
    assert.equal(store.conversation('g:R1RQ')!.request, undefined);
    assert.equal(store.conversation('g:R1RD'), undefined);

    await db.kvSet('syncedGroups', [group('R1RQ', {})]);
    await store.refreshDirectory();
    assert.equal(store.conversation('g:R1RQ')!.request, undefined);
  });

  it('lists an invite on Home as a request before any message arrives, and Accept takes it up', async () => {
    const invite = { id: 'group.R1IV', internal_id: 'R1IV', masterKey: '', revision: 1, name: 'Picnic', members: ['aci-dave'], admins: ['aci-dave'], pending: ['aci-me'], expireTimer: 0, blocked: false, link_mode: 'disabled', invite_link: '', messageRequest: true, pendingInvite: true, addedBy: 'aci-dave' };
    await db.kvSet('syncedGroups', [invite]);
    await store.refreshDirectory();
    const listed = store.conversations().find((c) => c.id === 'g:R1IV');
    assert.ok(listed, 'shown on Home');
    assert.equal(listed!.request, true);
    assert.equal(listed!.name, 'Picnic');

    const answers: any[] = [];
    (signal as any).answerGroupRequest = async (sendId: string, response: string) => {
      answers.push([sendId, response]);
    };
    await store.acceptRequest('g:R1IV');
    assert.deepEqual(answers, [['group.R1IV', 'accept']]);
    assert.equal(store.conversation('g:R1IV')!.request, undefined);
    await db.kvSet('syncedGroups', [{ ...invite, members: ['aci-dave', 'aci-me'], pending: [], messageRequest: undefined, pendingInvite: undefined }]);
    await store.refreshDirectory();
  });

  it('asks our phone for attachments the servers dropped, and gives up when the phone no longer has the message', async () => {
    const IVY = '+15550011';
    const asked: any[] = [];
    (signal as any).requestAttachmentBackfill = async (_sendId: string, ref: any) => {
      asked.push(ref);
      return true;
    };
    (signal as any).downloadAttachmentBlob = async (id: string) => {
      if (id.endsWith(':old')) throw Object.assign(new Error('HTTP 404'), { status: 404 });
      return new Blob(['fresh']);
    };
    const att = (id: string) => ({ id, contentType: 'application/pdf', filename: 'a.pdf', size: 5 });
    store.ingestRaw({ envelope: { sourceNumber: IVY, timestamp: 54000, dataMessage: { timestamp: 54000, attachments: [att('s4katt:a:old'), att('s4katt:b:old')] } } });
    await settle();
    const id = IVY + '|54000|' + IVY;
    const msg = (await db.getMessage(id))!;
    let asking = 0;
    const loaded = store.loadOrAskPhone(msg.attachments[0], msg, () => asking++);
    await settle();
    assert.equal(asking, 1);
    assert.deepEqual(asked, [{ author: IVY, timestamp: 54000 }]);

    const answer = (attachments: unknown) => ({ envelope: { sourceNumber: ME, syncMessage: { attachmentBackfill: { conversation: { number: IVY }, message: { author: IVY, timestamp: 54000 }, attachments } } } });
    store.ingestRaw(answer([att('s4katt:a:new'), 'pending']));
    assert.equal(await (await loaded).text(), 'fresh');
    await settle();
    const updated = (await db.getMessage(id))!;
    assert.deepEqual(updated.attachments.map((a) => a.id), ['s4katt:a:new', 's4katt:b:old']);

    const gone = store.loadOrAskPhone(updated.attachments[1], updated, () => {});
    await settle();
    store.ingestRaw(answer(null));
    await assert.rejects(gone, (e: unknown) => e instanceof store.NoLongerAvailableError);
    assert.equal(store.BACKFILL_WAIT_MS, 30000, 'a phone that’s asleep gets time to answer');
  });

  it('holds back someone we never accepted once Storage Service has said who we did', async () => {
    const HANK = '+15550030';
    const IVY = '+15550031';
    const JO = '+15550032';
    const hi = (from: string, ts: number) => ({ envelope: { sourceNumber: from, timestamp: ts, dataMessage: { timestamp: ts, message: 'hi' } } });
    await db.kvSet('syncedContacts', [{ uuid: 'aci-hank', number: HANK, name: 'Hank' }]);
    await store.refreshDirectory();
    store.ingestRaw(hi(HANK, 52000));
    await settle();
    assert.equal(store.conversation(HANK)!.request, undefined, 'before the first pull, a known contact isn’t held back');

    await db.kvSet('syncedContacts', [
      { uuid: 'aci-ivy', number: IVY, name: 'Ivy' },
      { uuid: 'aci-jo', number: JO, name: 'Jo', whitelisted: true },
    ]);
    await store.refreshDirectory();
    store.ingestRaw(hi(IVY, 52100));
    store.ingestRaw(hi(JO, 52200));
    await settle();
    assert.equal(store.conversation(IVY)!.request, true, 'only seen in a group, never accepted');
    assert.equal(store.conversation(JO)!.request, undefined, 'accepted');
  });

  it('starts requests for contacts we don’t share our profile with, and clears or deletes them from other devices', async () => {
    const FRANK = '+15550007';
    const GINA = '+15550008';
    await db.kvSet('syncedContacts', [
      { uuid: 'aci-frank', number: FRANK, name: 'Frank', whitelisted: false },
      { uuid: 'aci-gina', number: GINA, name: 'Gina', whitelisted: false },
    ]);
    await store.refreshDirectory();
    store.ingestRaw({ envelope: { sourceNumber: FRANK, timestamp: 51000, dataMessage: { timestamp: 51000, message: 'hello' } } });
    store.ingestRaw({ envelope: { sourceNumber: GINA, timestamp: 51000, dataMessage: { timestamp: 51000, message: 'hello' } } });
    await settle();
    assert.equal(store.conversation(FRANK)!.request, true);
    assert.equal(store.conversation(GINA)!.request, true);

    store.ingestRaw({ envelope: { sourceNumber: ME, timestamp: 51100, syncMessage: { sentMessage: { destinationNumber: GINA, timestamp: 51100, message: 'hey Gina' } } } });
    store.ingestRaw({ envelope: { sourceNumber: ME, syncMessage: { messageRequestResponse: { threadUuid: 'aci-frank', type: 'delete' } } } });
    await settle();
    assert.equal(store.conversation(GINA)!.request, undefined);
    assert.equal(store.conversation(FRANK), undefined);
  });

  it('keeps link previews and reports a message request as spam with its newest message IDs', async () => {
    const HANK = '+15550009';
    const guid = (n: number) => '00000000-0000-4000-8000-00000000000' + n;
    const calls: any[] = [];
    (signal as any).reportSpam = async (...args: any[]) => {
      calls.push(['report', ...args]);
      return args[1].length;
    };
    (signal as any).sendMessageRequestResponse = async (to: string, response: string) => {
      calls.push(['response', to, response]);
    };
    (signal as any).setContactBlocked = async (to: string, blocked: boolean) => {
      calls.push(['block', to, blocked]);
    };
    const preview = { url: 'https://signal.org/', title: 'Signal', description: 'Speak freely', image: { id: 's4katt:x', contentType: 'image/jpeg', filename: '', size: 10 } };
    for (let i = 1; i <= 4; i++) {
      store.ingestRaw({ envelope: { sourceNumber: HANK, timestamp: 52000 + i, serverGuid: guid(i), reportSpamToken: 'dG9rZW4' + i, dataMessage: { timestamp: 52000 + i, message: 'buy https://signal.org/', preview } } });
    }
    await settle();
    const rec = (await db.getMessage(HANK + '|52004|' + HANK))!;
    assert.equal(rec.preview!.title, 'Signal');
    assert.equal(rec.preview!.image!.id, 's4katt:x');
    assert.equal(rec.serverGuid, guid(4));
    assert.equal(store.conversation(HANK)!.request, true);

    await store.reportSpamRequest(HANK);
    assert.deepEqual(calls, [
      ['report', HANK, [guid(2), guid(3), guid(4)], 'dG9rZW44'],
      ['response', HANK, 'blockAndSpam'],
      ['block', HANK, true],
    ]);
    assert.equal(store.conversation(HANK), undefined);
  });

  it('saves the About emoji locally and on Signal', async () => {
    const uploaded: any[] = [];
    (signal as any).updateOwnProfile = async (body: any) => {
      uploaded.push(body);
    };
    await updateProfile({ name: 'Me', emoji: '🌻' });
    assert.equal(config.profileAboutEmoji(), '🌻');
    assert.deepEqual(uploaded, [{ name: 'Me', emoji: '🌻' }]);
  });

  it('shares read receipts and typing indicators with your other devices, so the next sync doesn’t undo them', async () => {
    const written: Array<[string, boolean]> = [];
    (signal as any).setReadReceipts = async (on: boolean) => {
      written.push(['receipts', on]);
    };
    (signal as any).setTypingIndicators = async (on: boolean) => {
      written.push(['typing', on]);
    };
    await setReadReceipts(false);
    await setTypingIndicators(false);
    assert.equal(config.sendReadReceipts(), false);
    assert.equal(config.typingIndicators(), false);
    await setReadReceipts(true);
    await setTypingIndicators(true);
    assert.deepEqual(written, [
      ['receipts', false],
      ['typing', false],
      ['receipts', true],
      ['typing', true],
    ]);
  });

  it('keeps the download id and bytes of attachments we send, so this phone opens them itself', async () => {
    (signal as any).send = async () => ({ timestamp: 8400, attachments: ['desc-photo'] });
    const rec = await store.sendAttachments(ALICE, [{ dataUri: 'data:image/jpeg;filename=a.jpg;base64,AQID', contentType: 'image/jpeg', filename: 'a.jpg', size: 3 }], '');
    assert.equal(rec.attachments[0].id, 'desc-photo');
    assert.equal((await db.getMessage(rec.id))!.attachments[0].id, 'desc-photo');
    await settle();
    const cached = await cachedAttachment(rec.attachments[0]);
    assert.ok(cached);
    assert.deepEqual(Array.from(new Uint8Array(await cached.arrayBuffer())), [1, 2, 3]);

    (signal as any).send = async () => ({ timestamp: 8500, attachments: ['desc-once'] });
    const once = await store.sendAttachments(ALICE, [{ dataUri: 'data:image/jpeg;base64,AQID', contentType: 'image/jpeg' }], '', { viewOnce: true });
    assert.equal(once.attachments[0].id, '', 'we can’t open our own view-once media');
  });

  it('retries a failed photo with its bytes and caption, and refuses once the bytes are gone', async () => {
    let last: any;
    const off = store.on('message', (m) => (last = m));
    const newest = async () => (await db.getMessage(last.id))!;
    const photo = { dataUri: 'data:image/jpeg;filename=b.jpg;base64,BAUG', contentType: 'image/jpeg', filename: 'b.jpg', size: 3, width: 4, height: 3 };
    (signal as any).send = async () => {
      throw new Error('offline');
    };
    await assert.rejects(store.sendAttachments(ALICE, [photo], 'look'));
    await settle();
    const failed = await newest();
    assert.equal(failed.status, 'failed');

    const sent: any[] = [];
    (signal as any).send = async (payload: any) => {
      sent.push(payload);
      return { timestamp: 8600, attachments: ['desc-retried'] };
    };
    const rec = await store.retryMessage(failed);
    assert.deepEqual(sent[0].base64_attachments, [photo.dataUri]);
    assert.equal(sent[0].message, 'look');
    assert.equal(rec.body, 'look');
    assert.equal(rec.attachments[0].filename, 'b.jpg');
    assert.equal(rec.attachments[0].width, 4);
    assert.equal(rec.attachments[0].id, 'desc-retried');
    assert.equal(await db.getMessage(failed.id), undefined, 'the failed copy is replaced');

    (signal as any).send = async () => {
      throw new Error('offline');
    };
    await assert.rejects(store.sendAttachments(ALICE, [photo], 'again'));
    await settle();
    const old = await newest();
    off();
    assert.equal(old.status, 'failed');
    await db.deleteAttachment('outbox:' + old.id + ':0');
    sent.length = 0;
    (signal as any).send = async (payload: any) => {
      sent.push(payload);
      return { timestamp: 8700 };
    };
    await assert.rejects(store.retryMessage(old), (e: unknown) => e instanceof store.RetryUnavailableError);
    assert.deepEqual(sent, [], 'nothing is sent');
    assert.ok(await db.getMessage(old.id), 'the message stays so it can be deleted');
  });

  it('files a message that names someone by ACI in the chat started with their number', async () => {
    const HANK = '+15550040';
    await db.kvSet('syncedContacts', [{ uuid: 'aci-hank', number: HANK, name: 'Hank' }]);
    await store.refreshDirectory();
    const conv = store.conversationWith({ number: HANK });
    assert.equal(store.conversationWith({ uuid: 'aci-hank' }).id, HANK);
    const ts = Date.now() + 400000;
    store.ingestRaw({ envelope: { sourceUuid: 'aci-hank', timestamp: ts, dataMessage: { timestamp: ts, message: 'hi by ACI' } } });
    await settle();
    assert.equal(store.conversation('aci-hank'), undefined);
    assert.equal(conv.lastTs, ts);
    assert.ok(await db.getMessage(HANK + '|' + ts + '|' + HANK));
  });

  it('merges two chats with one person once their number and ACI are linked, keeping read state and Retry', async () => {
    const IVY = '+15550050';
    await db.kvSet('syncedContacts', [{ uuid: 'aci-ivy', number: '', name: 'Ivy', whitelisted: true }]);
    await store.refreshDirectory();
    const ts = Date.now() + 500000;
    for (const at of [ts, ts + 1]) store.ingestRaw({ envelope: { sourceUuid: 'aci-ivy', timestamp: at, dataMessage: { timestamp: at, message: 'from ACI ' + at } } });
    await settle();
    store.markRead('aci-ivy');
    await settle();
    let last: any;
    const off = store.on('message', (m) => (last = m));
    (signal as any).send = async () => {
      throw new Error('offline');
    };
    const photo = { dataUri: 'data:image/jpeg;filename=c.jpg;base64,BwgJ', contentType: 'image/jpeg', filename: 'c.jpg', size: 3 };
    await assert.rejects(store.sendAttachments('aci-ivy', [photo], 'pic'));
    await settle();
    off();
    const failed = (await db.getMessage(last.id))!;
    assert.equal(failed.status, 'failed');
    store.ingestRaw({ envelope: { sourceNumber: ME, timestamp: ts + 2, syncMessage: { sentMessage: { destinationNumber: IVY, timestamp: ts + 2, message: 'from my phone' } } } });
    await settle();
    assert.ok(store.conversation(IVY) && store.conversation('aci-ivy'), 'two chats for now');

    await db.kvSet('syncedContacts', [{ uuid: 'aci-ivy', number: IVY, name: 'Ivy', whitelisted: true }]);
    await store.refreshDirectory();
    await settle();
    assert.equal(store.conversation('aci-ivy'), undefined);
    const conv = store.conversation(IVY)!;
    assert.equal(conv.lastTs, ts + 2);
    assert.ok(conv.lastReadTs >= ts + 1, 'read state kept');
    assert.equal(conv.unread, 0);
    for (const at of [ts, ts + 1]) assert.ok(await db.getMessage(IVY + '|' + at + '|' + IVY), 'moved ' + at);
    assert.equal(await db.getMessage('aci-ivy|' + ts + '|aci-ivy'), undefined);
    assert.ok(await db.getMessage(IVY + '|' + (ts + 2) + '|' + ME));
    assert.equal((await db.getMessagesPage('aci-ivy', Number.MAX_SAFE_INTEGER, 10)).length, 0);

    const moved = (await db.getMessage(IVY + '|' + failed.timestamp + '|' + failed.author))!;
    assert.equal(moved.status, 'failed');
    const sent: any[] = [];
    (signal as any).send = async (payload: any) => {
      sent.push(payload);
      return { timestamp: ts + 3, attachments: ['desc-merged'] };
    };
    await store.retryMessage(moved);
    assert.deepEqual(sent[0].base64_attachments, [photo.dataUri]);
  });

  it('applies read syncs to the chat the message is in, leaving newer messages unread', async () => {
    await db.kvSet('syncedContacts', [{ uuid: 'aci-erin', number: '+15550020', name: 'Erin' }, { uuid: 'aci-finn', number: '', name: 'aci-finn' }]);
    await db.kvSet('syncedGroups', [{ id: 'group.R1RS', internal_id: 'R1RS', masterKey: '', revision: 1, name: 'Club', members: ['aci-me', 'aci-erin'], admins: [], pending: [], expireTimer: 0, blocked: false, link_mode: 'disabled', invite_link: '' }]);
    await store.refreshDirectory();
    const ts = Date.now() + 100000;
    const inGroup = (at: number) => ({ envelope: { sourceNumber: '+15550020', sourceUuid: 'aci-erin', timestamp: at, dataMessage: { timestamp: at, groupInfo: { groupId: 'R1RS' }, message: 'hi ' + at } } });
    const readSync = (sender: string, at: number) => store.ingestRaw({ envelope: { sourceNumber: ME, syncMessage: { readMessages: [{ senderUuid: sender, timestamp: at }] } } });
    store.ingestRaw(inGroup(ts));
    store.ingestRaw(inGroup(ts + 1));
    await settle();
    const group = () => store.conversation('g:R1RS')!;
    assert.equal(group().unread, 2);

    let refreshed = 0;
    const off = store.on('conversations', () => refreshed++);
    readSync('aci-erin', ts);
    await settle();
    assert.equal(group().unread, 1, 'the newer message stays unread');
    assert.ok(refreshed > 0, 'the chat list refreshes');
    readSync('aci-erin', ts + 1);
    await settle();
    assert.equal(group().unread, 0);
    off();

    readSync('aci-erin', ts + 2);
    await settle();
    store.ingestRaw(inGroup(ts + 2));
    await settle();
    assert.equal(group().unread, 0, 'read on another device before it got here');

    store.ingestRaw({ envelope: { sourceUuid: 'aci-finn', timestamp: ts + 3, dataMessage: { timestamp: ts + 3, message: 'yo' } } });
    await settle();
    const finn = store.conversations().find((c) => c.sendId === 'aci-finn')!;
    assert.equal(finn.unread, 1);
    readSync('aci-finn', ts + 3);
    await settle();
    assert.equal(store.conversation(finn.id)!.unread, 0, 'a contact known only by ACI');
  });

  it('starts a received disappearing message’s timer when it’s read, here or on another device', async () => {
    const GINA = '+15550030';
    await db.kvSet('syncedContacts', [{ uuid: 'aci-gina', number: GINA, name: 'Gina' }]);
    await store.refreshDirectory();
    const ts = Date.now() + 200000;
    const vanishing = (at: number) => ({ envelope: { sourceNumber: GINA, sourceUuid: 'aci-gina', timestamp: at, dataMessage: { timestamp: at, message: 'psst ' + at, expiresInSeconds: 60 } } });
    const readSync = (at: number) => store.ingestRaw({ envelope: { sourceNumber: ME, syncMessage: { readMessages: [{ senderUuid: 'aci-gina', timestamp: at }] } } });
    const stored = async (at: number) => (await db.getMessage(GINA + '|' + at + '|' + GINA))!;
    store.ingestRaw(vanishing(ts));
    store.ingestRaw(vanishing(ts + 1));
    await settle();
    assert.equal((await stored(ts)).expireSecs, 60);
    assert.equal((await stored(ts)).expiresAt, undefined, 'unread, so the timer waits');
    await store.purgeExpired();
    assert.ok(await db.getMessage(GINA + '|' + ts + '|' + GINA), 'not purged before it is read');

    readSync(ts);
    await settle();
    const started = (await stored(ts)).expiresAt!;
    assert.ok(Math.abs(started - (Date.now() + 60000)) < 5000, 'a read on another device starts it');
    assert.equal((await stored(ts + 1)).expiresAt, undefined, 'the newer one still waits');

    store.markRead(GINA);
    await settle();
    assert.ok((await stored(ts + 1)).expiresAt, 'reading here starts it');

    readSync(ts + 5);
    await settle();
    store.ingestRaw(vanishing(ts + 5));
    await settle();
    assert.ok((await stored(ts + 5)).expiresAt, 'read elsewhere before it arrived, so it starts at once');
  });

  it('starts a disappearing message sent from another device at its send time', async () => {
    const sentAt = Date.now() - 30000;
    store.ingestRaw({ envelope: { sourceNumber: ME, timestamp: sentAt, syncMessage: { sentMessage: { destinationNumber: '+15550030', timestamp: sentAt, message: 'from my phone', expiresInSeconds: 3600 } } } });
    await settle();
    assert.equal((await db.getMessage('+15550030|' + sentAt + '|' + ME))!.expiresAt, sentAt + 3600000);
  });

  it('restarts timers that began on arrival before 2.10.6, once, for messages still unread', async () => {
    const GINA = '+15550030';
    const ts = Date.now() + 300000;
    store.ingestRaw({ envelope: { sourceNumber: GINA, timestamp: ts + 1, dataMessage: { timestamp: ts + 1, message: 'newest' } } });
    await settle();
    const id = GINA + '|' + ts + '|' + GINA;
    await db.putMessage({ id, convId: GINA, incoming: true, author: GINA, authorName: '', timestamp: ts, body: 'old style', styles: [], quote: null, attachments: [], reactions: {}, status: 'received', deleted: false, edited: false, expireSecs: 60, expiresAt: Date.now() + 1000 });
    await db.kvSet('expiryOnRead', false);
    await store.init();
    clearInterval(storeState.purgeTimer!);
    storeState.purgeTimer = null;
    await settle();
    assert.equal((await db.getMessage(id))!.expiresAt, undefined);
    store.markRead(GINA);
    await settle();
    assert.ok((await db.getMessage(id))!.expiresAt! > Date.now() + 50000);
  });

  it('resolves once a frame is stored, and rejects with SaveError when the database refuses a write', async () => {
    await store.ingestRaw(incoming(9400, 'stored first'));
    assert.equal((await db.getMessage(ALICE + '|9400|' + ALICE))!.body, 'stored first', 'stored by the time it resolves');

    const put = db.putMessage;
    let failures = 0;
    (db as any).putMessage = (rec: any) => (failures-- > 0 ? Promise.reject(new DOMException('disk full', 'QuotaExceededError')) : put.call(db, rec));
    try {
      failures = 1;
      await assert.rejects(store.ingestRaw(incoming(9500, 'no room')), (e: unknown) => e instanceof store.SaveError);
      failures = 1;
      const reaction = { envelope: { sourceNumber: ALICE, timestamp: 9510, dataMessage: { reaction: { emoji: '👍', targetAuthorNumber: ALICE, targetSentTimestamp: 9400 } } } };
      await assert.rejects(store.ingestRaw(reaction), (e: unknown) => e instanceof store.SaveError, 'a reaction’s write counts too');
      await store.ingestRaw(incoming(9500, 'no room'));
      await store.ingestRaw(reaction);
    } finally {
      (db as any).putMessage = put;
    }
    assert.equal((await db.getMessage(ALICE + '|9500|' + ALICE))!.body, 'no room', 'stored on the retry');
    assert.equal((await db.getMessage(ALICE + '|9400|' + ALICE))!.reactions[ALICE], '👍');
  });

  it('marks a send cut off by closing the app as failed at the next start, so Retry is offered', async () => {
    const ts = Date.now();
    const id = ALICE + '|' + ts + '|' + ME;
    await db.putMessage({ id, convId: ALICE, incoming: false, author: ME, authorName: '', timestamp: ts, body: 'interrupted', styles: [], quote: null, attachments: [], reactions: {}, status: 'pending', deleted: false, edited: false });
    const updated: string[] = [];
    const off = store.on('message-updated', (rec) => updated.push(rec.id + ' ' + rec.status));
    await settle(5);
    await store.init();
    clearInterval(storeState.purgeTimer!);
    storeState.purgeTimer = null;
    await settle();
    off();
    assert.equal((await db.getMessage(id))!.status, 'failed');
    assert.deepEqual(updated, [id + ' failed']);
  });

  it('won’t open view-once media again once viewed, even after the cache has forgotten it', async () => {
    const downloads: string[] = [];
    (signal as any).downloadAttachmentBlob = async (id: string) => {
      downloads.push(id);
      return new Blob(['secret']);
    };
    store.ingestRaw(incoming(9300, '', { attachments: [{ id: 'att-once-pruned', contentType: 'image/jpeg' }], viewOnce: true }));
    await settle();
    const rec = (await db.getMessage(ALICE + '|9300|' + ALICE))!;
    assert.equal(rec.attachments[0].viewOnce, true);
    rec.viewed = true;
    await assert.rejects(store.loadOrAskPhone(rec.attachments[0], rec, () => {}), (e: unknown) => e instanceof ViewedOnceError);
    assert.deepEqual(downloads, [], 'nothing is downloaded');

    await db.putAttachment('att-once-marker', new Blob([]), '');
    for (let i = 0; i < 4; i++) await db.putAttachment('att-fill-' + i, new Blob(['x']), 'image/jpeg');
    await db.pruneAttachments(2);
    assert.ok(await db.getAttachment('att-once-marker'), 'the viewed marker survives the prune');
    let kept = 0;
    for (let i = 0; i < 4; i++) if (await db.getAttachment('att-fill-' + i)) kept++;
    assert.ok(kept <= 2);
  });

  it('keeps the attachment cache within its byte budget, dropping unsent files last', async () => {
    const big = (n: number) => new Blob([new Uint8Array(n)]);
    await db.putAttachment('outbox:m1:0', big(400), 'image/jpeg');
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 2));
      await db.putAttachment('att-big-' + i, big(300), 'image/jpeg');
    }
    await db.putAttachment('avatar:alice', big(500), 'image/jpeg');
    await db.pruneAttachments(150, 1000);
    assert.ok(await db.getAttachment('outbox:m1:0'), 'the bytes Retry needs stay');
    assert.ok(await db.getAttachment('avatar:alice'), 'avatars are kept');
    assert.ok(await db.getAttachment('att-big-3'), 'the newest file stays');
    assert.ok(await db.getAttachment('att-big-2'));
    assert.equal(await db.getAttachment('att-big-1'), undefined);
    assert.equal(await db.getAttachment('att-big-0'), undefined);
  });

  it('downloads only photos whose size is known and small on their own', () => {
    assert.ok(autoDownloads({ id: 'a', contentType: 'image/jpeg', size: 1000 } as any));
    assert.ok(!autoDownloads({ id: 'a', contentType: 'image/jpeg', size: 0 } as any));
    assert.ok(!autoDownloads({ id: 'a', contentType: 'image/jpeg' } as any));
    assert.ok(!autoDownloads({ id: 'a', contentType: 'image/jpeg', size: 5_000_000 } as any));
  });

  it('deletes the keys but keeps the messages when Signal unlinks this phone', async () => {
    await db.signalKeySet('account', { aci: 'aci-me', password: 'test-only' });
    await db.putSession('aci-zed.1', new Uint8Array([1, 2, 3]));
    await forgetUnlinkedDevice();
    assert.equal(await db.signalKeyGet('account'), undefined);
    assert.equal(await db.getSession('aci-zed.1'), undefined);
    assert.ok(await db.getMessage(ALICE + '|1000|' + ALICE), 'history stays');
  });
});
