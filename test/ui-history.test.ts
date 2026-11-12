import './ui-env';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { HistoryItem, HistoryMessage } from '../src/engine';
import { AUTOMATIC, CHAT_COLORS, chatColorClass, chatColorOf } from '../src/ui/data/chat-colors';
import { config } from '../src/ui/data/config';
import { db, PRUNE_KEEP } from '../src/ui/data/db';
import * as store from '../src/ui/data/store';
import { HistoryImport } from '../src/ui/data/store/history';
import type { Conversation } from '../src/ui/data/types';
import { BOB } from './helpers';

const ME = '+15550000';
const BOB_NUMBER = '+15550002';
const CAROL = '+15550003';

function msg(ts: number, over: Partial<HistoryMessage> = {}): HistoryMessage {
  return { t: 'message', convId: BOB_NUMBER, groupInternalId: null, incoming: true, author: BOB_NUMBER, timestamp: ts, read: true, status: 'received', reactions: {}, dm: { message: 'm' + ts }, ...over };
}

describe('message history import', () => {
  before(async () => {
    config.set({ number: ME, aci: 'aci-me', deviceId: 2, deviceToken: 'test-only' });
    await db.ready();
  });

  it('stores chats and messages without notifying, and marks strangers as message requests', async () => {
    let events = 0;
    const off = store.on('message', () => events++);
    const run = new HistoryImport([], ME);
    const items: HistoryItem[] = [
      { t: 'contact', aci: BOB, e164: BOB_NUMBER, name: 'Bob', blocked: false, whitelisted: true },
      { t: 'contact', aci: '', e164: CAROL, name: 'Carol', blocked: false, whitelisted: false },
      { t: 'chat', convId: BOB_NUMBER, groupInternalId: null, archived: false, pinned: true, mutedUntil: 0, markedUnread: false, expireTimer: 3600 },
      msg(1000, { read: false, reactions: { [ME]: '👍' }, revisions: [{ message: 'helo', timestamp: 900 }] }),
      msg(2000, { incoming: false, author: ME, status: 'read', dm: { message: 're', quote: { id: 1000, authorNumber: BOB_NUMBER, text: 'hello', attachments: [] } } }),
      msg(3000, { dm: undefined, notice: { kind: 'timer', seconds: 3600 } }),
      msg(4000, { convId: CAROL, author: CAROL, read: false }),
    ];
    await run.apply(items);
    await run.finish();
    off();
    assert.equal(events, 0);

    const [first, reply, timer] = await db.getMessagesPage(BOB_NUMBER, Infinity, 10).then((list) => list.sort((a, b) => a.timestamp - b.timestamp));
    assert.equal(first.body, 'm1000');
    assert.equal(first.edited, true);
    assert.deepEqual(first.history!.map((h) => h.body), ['helo']);
    assert.deepEqual(first.reactions, { [ME]: '👍' });
    assert.equal(reply.incoming, false);
    assert.equal(reply.status, 'read');
    assert.equal(reply.quote!.text, 'hello');
    assert.deepEqual(timer.notice, { kind: 'timer', seconds: 3600 });

    const convs = await db.allConversations();
    const bob = convs.find((c) => c.id === BOB_NUMBER)!;
    assert.equal(bob.name, 'Bob');
    assert.equal(bob.pinned, true);
    assert.equal(bob.expireTimer, 3600);
    assert.equal(bob.unread, 1);
    assert.equal(bob.lastTs, 3000);
    assert.ok(!bob.request);
    assert.equal(convs.find((c) => c.id === CAROL)!.request, true);
  });

  it('keeps the newest messages of a long chat', async () => {
    const run = new HistoryImport([], ME);
    const id = '+15550099';
    const total = PRUNE_KEEP * 3;
    for (let start = 0; start < total; start += 100) await run.apply(Array.from({ length: 100 }, (_, i) => msg(10_000 + start + i, { convId: id, author: id })));
    await run.finish();
    assert.equal(await db.countMessages(id), PRUNE_KEEP);
    const newest = await db.getMessagesPage(id, Infinity, 1);
    assert.equal(newest[0].timestamp, 10_000 + total - 1);
  });

  it('takes the default and per-chat bubble colors, ignoring names Beacon has no class for', async () => {
    const run = new HistoryImport([], ME);
    const chat = (convId: string, chatColor?: string): HistoryItem => ({ t: 'chat', convId, groupInternalId: null, archived: false, pinned: true, mutedUntil: 0, markedUnread: false, expireTimer: 0, chatColor });
    await run.apply([{ t: 'account', chatColor: 'ember' }, chat('+15550101', 'sea'), chat('+15550102', 'chartreuse" onload="x'), chat('+15550103')]);
    await run.finish();
    assert.equal(config.chatColor(), 'ember');
    const convs = await db.allConversations();
    assert.deepEqual(['+15550101', '+15550102', '+15550103'].map((id) => convs.find((c) => c.id === id)!.chatColor), ['sea', undefined, undefined]);
    await run.apply([{ t: 'account', chatColor: 'nope' }]);
    assert.equal(config.chatColor(), 'ember');
    config.set({ chatColor: undefined });
  });
});

describe('chat colors', () => {
  it('uses the chat\'s own color, then the default, then automatic', () => {
    config.set({ chatColor: undefined });
    assert.equal(chatColorOf({ chatColor: 'basil' }), 'basil');
    assert.equal(chatColorOf({}), AUTOMATIC);
    assert.equal(chatColorOf(undefined), AUTOMATIC);
    config.set({ chatColor: 'plum' });
    assert.equal(chatColorOf({}), 'plum');
    assert.equal(chatColorOf({ chatColor: 'unknown' }), 'plum');
    assert.equal(chatColorOf({ chatColor: 'teal' }), 'teal');
    config.set({ chatColor: 'unknown' });
    assert.equal(chatColorOf({}), AUTOMATIC);
    config.set({ chatColor: undefined });
  });

  it('follows the protocol\'s preset order', () => {
    assert.equal(CHAT_COLORS.length, 22);
    assert.equal(CHAT_COLORS[0], 'ultramarine');
    assert.equal(CHAT_COLORS[13], 'ember');
    assert.equal(CHAT_COLORS[21], 'tangerine');
    assert.equal(chatColorClass(AUTOMATIC), '');
    assert.equal(chatColorClass('violet'), 'chat-color-violet');
  });
});

describe('chat folders (Signal-Desktop isConversationInChatFolder)', () => {
  const base = { id: 'f', name: 'F', position: 1, all: false, showOnlyUnread: false, showMutedChats: true, includeAllIndividualChats: false, includeAllGroupChats: false, included: [] as string[], excluded: [] as string[] };
  const direct = { id: BOB_NUMBER, type: 'direct', unread: 0 } as Conversation;
  const group = { id: 'g:abc', type: 'group', groupInternalId: 'abc', unread: 2 } as Conversation;
  const muted = { id: CAROL, type: 'direct', unread: 0, mutedUntil: Date.now() + 60000 } as Conversation;

  before(async () => {
    await db.ready();
    await db.kvSet('syncedContacts', [{ uuid: BOB, number: BOB_NUMBER, name: 'Bob' }]);
    await store.refreshDirectory();
  });

  it('includes by type or by name, then leaves out unread-only, muted, and excluded chats', () => {
    const inc = (over: Partial<typeof base>, c: Conversation) => store.folderIncludes({ ...base, ...over }, c);
    assert.equal(inc({ all: true }, muted), true);
    assert.equal(inc({}, direct), false);
    assert.equal(inc({ includeAllIndividualChats: true }, direct), true);
    assert.equal(inc({ includeAllIndividualChats: true }, group), false);
    assert.equal(inc({ includeAllGroupChats: true }, group), true);
    assert.equal(inc({ included: [BOB] }, direct), true, 'a contact named by ACI matches the chat keyed by number');
    assert.equal(inc({ included: ['g:abc'] }, group), true);
    assert.equal(inc({ includeAllIndividualChats: true, showOnlyUnread: true }, direct), false);
    assert.equal(inc({ includeAllIndividualChats: true, showOnlyUnread: true }, { ...direct, markedUnread: true }), true);
    assert.equal(inc({ includeAllIndividualChats: true, showMutedChats: false }, muted), false);
    assert.equal(inc({ includeAllIndividualChats: true }, muted), true);
    assert.equal(inc({ includeAllIndividualChats: true, excluded: [BOB_NUMBER] }, direct), false);
  });

  it('puts "All chats" first when the phone has not placed it, and orders by position', () => {
    assert.deepEqual(store.foldersInOrder([]), []);
    const list = store.foldersInOrder([{ ...base, id: 'b', position: 2 }, { ...base, id: 'a', position: 1 }]);
    assert.deepEqual(list.map((f) => [f.id, f.all]), [['', true], ['a', false], ['b', false]]);
    const placed = store.foldersInOrder([{ ...base, id: 'a', position: 0 }, { ...base, id: 'all', all: true, position: 1 }]);
    assert.deepEqual(placed.map((f) => f.id), ['a', 'all']);
  });

  it('counts folder names in characters a reader sees', () => {
    assert.equal(store.graphemeCount('Family'), 6);
    assert.equal(store.graphemeCount('e\u0301te\u0301'), 3);
    assert.equal(store.graphemeCount('👨‍👩‍👧 ok'), 4);
    assert.equal(store.graphemeCount('👍🏽'), 1);
  });
});
