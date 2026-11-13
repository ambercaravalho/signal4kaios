import './ui-env';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'preact-render-to-string';

import type { CallState } from '../src/engine';
import { _stackForTest, router, RouterView } from '../src/ui/app/router';
import { _setCallStateForTest, callView } from '../src/ui/data/calls';
import { config } from '../src/ui/data/config';
import { db } from '../src/ui/data/db';
import { parseFrame } from '../src/ui/data/normalize';
import * as screenLock from '../src/ui/data/screen-lock';
import * as store from '../src/ui/data/store';
import { CallScreen, installCallScreen } from '../src/ui/screens/Call';
import { HomeScreen } from '../src/ui/screens/Home';
import { LockGate } from '../src/ui/screens/Lock';
import { ALICE as ALICE_ACI, BOB as STRANGER, settle } from './helpers';

const ME = '+15550000';
const ALICE = '+15550001';

function callFrame(ts: number, callRecord: Record<string, unknown>, peer = ALICE_ACI) {
  return { envelope: { source: peer, sourceUuid: peer, sourceDevice: 1, timestamp: ts, callRecord } };
}

function syncFrame(syncMessage: Record<string, unknown>) {
  return { envelope: { source: 'aci-me', sourceUuid: 'aci-me', timestamp: Date.now(), syncMessage } };
}

const line = (callId: string) => db.getMessage(ALICE + '|call|' + callId);
const text = () => renderToString(<RouterView />).replace(/<[^>]+>/g, ' ').replace(/&rsquo;|&#39;/g, '’');

function state(over: Partial<CallState>): CallState {
  return { callId: '1', peer: ALICE_ACI, direction: 'incoming', phase: 'incoming', muted: false, remoteMuted: false, startedAt: Date.now(), connectedAt: null, endReason: null, ...over };
}

describe('call lines', () => {
  before(async () => {
    config.set({ number: ME, aci: 'aci-me', deviceId: 2, deviceToken: 'test-only' });
    await db.ready();
    await db.kvSet('syncedContacts', [{ uuid: ALICE_ACI, number: ALICE, name: 'Alice', whitelisted: true }]);
    await store.refreshDirectory();
    store.ingestRaw({ envelope: { sourceNumber: ALICE, sourceUuid: ALICE_ACI, timestamp: 1000, dataMessage: { timestamp: 1000, message: 'hi' } } });
    await settle();
    store.markRead(ALICE);
  });

  it('drops call frames it cannot trust', () => {
    const nameOf = (k: string) => k;
    assert.deepEqual(parseFrame(callFrame(5, { callId: '7', direction: 'incoming', outcome: 'missed' }, '+1555'), ME, nameOf), []);
    assert.deepEqual(parseFrame(callFrame(5, { callId: 'x7', direction: 'incoming', outcome: 'missed' }), ME, nameOf), []);
    assert.deepEqual(parseFrame(callFrame(5, { callId: '7', direction: 'sideways', outcome: 'missed' }), ME, nameOf), []);
    assert.deepEqual(parseFrame(syncFrame({ callEvent: { peer: ALICE_ACI, callId: '7', type: 'group', direction: 'incoming', event: 'accepted', timestamp: 5 } }), ME, nameOf), []);
    assert.deepEqual(parseFrame(syncFrame({ callLogEvent: { type: 'clearInConversation', timestamp: 5 } }), ME, nameOf), []);
    const [ev] = parseFrame(callFrame(5, { callId: '7', direction: 'outgoing', outcome: 'accepted', durationMs: 1e12 }), ME, nameOf);
    assert.deepEqual(ev, { type: 'call', chat: { key: ALICE_ACI }, callId: '7', direction: 'outgoing', outcome: 'accepted', timestamp: 5, durationMs: 86_400_000 });
  });

  it('puts a missed call in the chat stored under the number, unread, and an answer on another device replaces it', async () => {
    store.ingestRaw(callFrame(2000, { callId: '100', direction: 'incoming', outcome: 'missed', durationMs: 0 }));
    await settle();
    const conv = store.conversation(ALICE)!;
    assert.equal(store.conversation(ALICE_ACI), undefined, 'no second chat for the account ID');
    assert.equal(conv.unread, 1);
    assert.equal(conv.lastPreview, 'Missed voice call');
    assert.deepEqual((await line('100'))!.notice, { kind: 'call', callId: '100', direction: 'incoming', outcome: 'missed', durationMs: 0 });

    store.ingestRaw(syncFrame({ callEvent: { peer: ALICE_ACI, callId: '100', type: 'audio', direction: 'incoming', event: 'accepted', timestamp: 2000 } }));
    await settle();
    assert.equal((await line('100'))!.notice!.outcome, 'accepted');
    assert.equal(store.conversation(ALICE)!.unread, 0);
    assert.equal(store.conversation(ALICE)!.lastPreview, 'Incoming voice call');

    store.ingestRaw(callFrame(2000, { callId: '100', direction: 'incoming', outcome: 'missed', durationMs: 0 }));
    await settle();
    assert.equal((await line('100'))!.notice!.outcome, 'accepted', 'an answered call stays answered');
  });

  it('shows how long an answered call lasted, and how calls that weren’t answered ended', async () => {
    store.ingestRaw(callFrame(3000, { callId: '101', direction: 'outgoing', outcome: 'accepted', durationMs: 65_400 }));
    await settle();
    assert.equal(store.conversation(ALICE)!.lastPreview, 'Outgoing voice call · 1:05');
    store.ingestRaw(syncFrame({ callEvent: { peer: ALICE_ACI, callId: '102', type: 'audio', direction: 'outgoing', event: 'notAccepted', timestamp: 3100 } }));
    store.ingestRaw(syncFrame({ callEvent: { peer: ALICE_ACI, callId: '103', type: 'audio', direction: 'incoming', event: 'notAccepted', timestamp: 3200 } }));
    await settle();
    assert.equal(store.noticeText((await line('102'))!.notice!, ''), 'Unanswered voice call');
    assert.equal(store.noticeText((await line('103'))!.notice!, ''), 'Declined voice call');
    assert.equal(store.conversation(ALICE)!.unread, 0);
  });

  it('follows call logs read and cleared on other devices, and deleted calls', async () => {
    store.ingestRaw(callFrame(4000, { callId: '104', direction: 'incoming', outcome: 'missed', durationMs: 0 }));
    await settle();
    assert.equal(store.conversation(ALICE)!.unread, 1);
    store.ingestRaw(syncFrame({ callLogEvent: { type: 'read', timestamp: 4000 } }));
    await settle();
    assert.equal(store.conversation(ALICE)!.unread, 0);
    assert.equal((await line('104'))!.notice!.read, true);

    store.ingestRaw(syncFrame({ callEvent: { peer: ALICE_ACI, callId: '101', type: 'audio', direction: 'outgoing', event: 'delete', timestamp: 3000 } }));
    await settle();
    assert.equal(await line('101'), undefined);

    store.ingestRaw(syncFrame({ callLogEvent: { type: 'clearInConversation', peer: ALICE_ACI, timestamp: 3500 } }));
    await settle();
    assert.equal(await line('100'), undefined);
    assert.equal(await line('103'), undefined);
    assert.ok(await line('104'), 'calls after the clear stay');
    store.ingestRaw(syncFrame({ callLogEvent: { type: 'clear', timestamp: 5000 } }));
    await settle();
    assert.equal(await line('104'), undefined);
    assert.equal(store.conversation(ALICE)!.lastPreview, 'hi');
    assert.ok(await db.getMessage(ALICE + '|1000|' + ALICE), 'messages stay');
  });
});

describe('call screen', () => {
  before(() => {
    router.reset(HomeScreen, {});
    installCallScreen();
  });

  it('opens over the current screen for an incoming call and shows who is calling', () => {
    _setCallStateForTest(state({ callId: '200' }));
    assert.ok(router.has(CallScreen));
    const t = text();
    assert.match(t, /Voice call/);
    assert.match(t, /Alice/);
    assert.match(t, /Incoming voice call/);
  });

  it('shows the time on the call and who is muted', () => {
    _setCallStateForTest(state({ callId: '200', phase: 'connected', connectedAt: Date.now() - 65_000, muted: true, remoteMuted: true }));
    const t = text();
    assert.match(t, /1:05/);
    assert.match(t, /You’re muted/);
    assert.match(t, /Alice is muted/);
  });

  it('says how the call ended, then closes when it is cleared', () => {
    _setCallStateForTest(state({ callId: '201', direction: 'outgoing', phase: 'ended', endReason: 'busy' }));
    assert.match(text(), /Alice is on another call/);
    _setCallStateForTest(null);
    assert.ok(!router.has(CallScreen));
    assert.equal(_stackForTest().length, 1);
  });

  it('shows a call over the screen lock, and locks again once the call is cleared', async () => {
    await screenLock.enable('4821');
    screenLock.lockNow();
    assert.match(renderToString(<LockGate />), /class="lock"/);
    _setCallStateForTest(state({ callId: '203' }));
    assert.ok(router.has(CallScreen));
    assert.equal(renderToString(<LockGate />), '');
    _setCallStateForTest(null);
    assert.ok(screenLock.isLocked());
    assert.match(renderToString(<LockGate />), /class="lock"/);
    screenLock.disable();
    screenLock.unlock();
  });

  it('doesn’t ring for someone it doesn’t know', () => {
    _setCallStateForTest(state({ callId: '202', peer: STRANGER }));
    assert.equal(callView(), null);
    assert.ok(!router.has(CallScreen));
    _setCallStateForTest(null);
  });
});
