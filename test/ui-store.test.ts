import './ui-env';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { signal, updateProfile } from '../src/ui/data/api';
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

  it('forwards text with its formatting and an attachment without its mentions', async () => {
    const sent: any[] = [];
    (signal as any).send = async (payload: any) => {
      sent.push(payload);
      return { timestamp: 5050 };
    };
    const src = (await db.getMessage(ALICE + '|1500|' + ALICE))!;
    const fwd = { ...src, body: 'hi @Bob', styles: [{ start: 0, length: 2, style: 'BOLD' }], mentions: [{ name: 'Bob', uuid: 'aci-bob' }], attachments: [{ id: 'x', contentType: 'image/png', filename: 'a.png', size: 3 }] };
    const rec = await store.forwardMessage(ALICE, fwd, 'data:image/png;base64,AAAA');
    assert.equal(sent[0].message, 'hi @Bob');
    assert.deepEqual(sent[0].styles, [{ start: 0, length: 2, style: 'BOLD' }]);
    assert.equal(sent[0].mentions, undefined);
    assert.deepEqual(sent[0].base64_attachments, ['data:image/png;base64,AAAA']);
    assert.equal(rec.attachments[0].id, '');
    assert.equal(rec.incoming, false);
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
    assert.equal(conv.lastPreview, 'Missed voice call');
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

  it('marks a chat unread, syncs it, and clears it when the chat is read', () => {
    const synced: any[] = [];
    (signal as any).syncChatState = async (s: any) => {
      synced.push(s);
    };
    (signal as any).sendReadReceipt = async () => {};
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
    const rec = await store.sendAttachment(ALICE, 'data:image/jpeg;base64,AAAA', 'a caption', { contentType: 'image/jpeg', viewOnce: true });
    assert.equal(sent[0].view_once, true);
    assert.equal(sent[0].message, '');
    assert.equal(rec.body, '');
    assert.equal(rec.attachments[0].viewOnce, true);
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

  it('holds a stranger’s chat as a message request, without read receipts, until it is accepted', async () => {
    const ERIN = '+15550006';
    const receipts: any[] = [];
    const responses: any[] = [];
    (signal as any).sendReadReceipt = async (to: string, ts: number) => {
      receipts.push([to, ts]);
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

  it('saves the About emoji locally and on Signal', async () => {
    const uploaded: any[] = [];
    (signal as any).updateOwnProfile = async (body: any) => {
      uploaded.push(body);
    };
    await updateProfile({ name: 'Me', emoji: '🌻' });
    assert.equal(config.profileAboutEmoji(), '🌻');
    assert.deepEqual(uploaded, [{ name: 'Me', emoji: '🌻' }]);
  });
});
