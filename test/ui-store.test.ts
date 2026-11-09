import './ui-env';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { signal } from '../src/ui/data/api';
import { config } from '../src/ui/data/config';
import { db } from '../src/ui/data/db';
import * as store from '../src/ui/data/store';

const ME = '+15550000';
const ALICE = '+15550001';

function settle(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function incoming(ts: number, body: string, extra: Record<string, unknown> = {}) {
  return { envelope: { sourceNumber: ALICE, sourceName: 'Alice', timestamp: ts, dataMessage: { timestamp: ts, message: body, ...extra } } };
}

describe('store', () => {
  before(async () => {
    config.set({ number: ME, aci: 'aci-me', deviceId: 2, deviceToken: 'test-only' });
    await db.ready();
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

  it('marks a failed send and clears unread from another device', async () => {
    (signal as any).send = async () => {
      throw new Error('offline');
    };
    await assert.rejects(store.sendText(ALICE, 'nope'));
    await settle();
    const page = await db.getMessagesPage(ALICE, Number.MAX_SAFE_INTEGER, 10);
    assert.equal(page[page.length - 1].status, 'failed');

    store.ingestRaw({ envelope: { sourceNumber: ME, syncMessage: { readMessages: [{ senderNumber: ALICE, timestamp: 1000 }] } } });
    assert.equal(store.conversation(ALICE)!.unread, 0);
  });

  it('archives, keeps muted chats archived, and limits pinned chats', async () => {
    (signal as any).syncChatState = async () => {};
    store.setArchived(ALICE, true);
    store.setMuted(ALICE, true);
    assert.deepEqual(store.conversations(), []);
    store.ingestRaw(incoming(6000, 'still archived'));
    await settle();
    assert.equal(store.archivedConversations().length, 1);

    store.setMuted(ALICE, false);
    store.ingestRaw(incoming(7000, 'back'));
    await settle();
    assert.equal(store.conversations().length, 1);

    for (let i = 0; i < store.MAX_PINNED_CHATS; i++) {
      const c = store.conversationWith({ number: '+1555100' + i });
      assert.equal(store.setConvPinned(c.id, true), true);
    }
    assert.equal(store.setConvPinned(ALICE, true), false);
  });
});
