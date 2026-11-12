import './ui-env';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { create } from '@bufbuild/protobuf';
import { AttachmentPointerSchema } from '../src/engine/gen/SignalService_pb';
import { GroupV2RecordSchema, OptionalBool } from '../src/engine/gen/SignalStorage_pb';
import { applyAttachmentMeta, receivedMeta } from '../src/engine/services/attachment-meta';
import { resolveLegacyNotifyForMentionsIfMuted, setNotifyForMentionsIfMuted } from '../src/engine/services/storage';
import { applyTheme, setTextSize, TEXT_SIZE_PX } from '../src/ui/app/theme';
import { signal } from '../src/ui/data/api';
import { hashPixels, hashToPixels, placeholderSize } from '../src/ui/data/blurhash';
import { config } from '../src/ui/data/config';
import { db } from '../src/ui/data/db';
import { parseFrame } from '../src/ui/data/normalize';
import * as store from '../src/ui/data/store';
import type { Conversation } from '../src/ui/data/types';
import { settle } from './helpers';

const ME = '+15550000';
const HASH = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';

function group(extra: Partial<Conversation> = {}): Conversation {
  return { id: 'g:X', type: 'group', sendId: 'group.X', name: 'G', lastTs: 0, lastPreview: '', unread: 0, lastReadTs: 0, ...extra };
}

describe('mentions in muted chats', () => {
  before(async () => {
    config.set({ number: ME, aci: 'aci-me', deviceId: 2, deviceToken: 'test-only' });
    await db.ready();
  });

  it('reconciles the deprecated field as Signal-Desktop does', () => {
    assert.equal(resolveLegacyNotifyForMentionsIfMuted(true, true), false);
    assert.equal(resolveLegacyNotifyForMentionsIfMuted(true, undefined), false);
    assert.equal(resolveLegacyNotifyForMentionsIfMuted(false, undefined), undefined);
    assert.equal(resolveLegacyNotifyForMentionsIfMuted(false, true), true);
    assert.equal(resolveLegacyNotifyForMentionsIfMuted(false, false), true);

    const g = create(GroupV2RecordSchema, {});
    setNotifyForMentionsIfMuted(g, false);
    assert.equal(g.notifyForMentionsIfMuted, OptionalBool.DISABLED);
    assert.equal(g.dontNotifyForMentionsIfMuted, true);
    setNotifyForMentionsIfMuted(g, true);
    assert.equal(g.notifyForMentionsIfMuted, OptionalBool.ENABLED);
    assert.equal(g.dontNotifyForMentionsIfMuted, false);
  });

  it('lets a mention of us through a muted group unless that is turned off', () => {
    const muted = (extra: Partial<Conversation> = {}) => group({ mutedUntil: store.MUTED_ALWAYS, ...extra });
    assert.equal(store.shouldNotify(group()), true);
    assert.equal(store.shouldNotify(muted()), false);
    assert.equal(store.shouldNotify(muted(), { mentioned: ['aci-other'] }), false);
    assert.equal(store.shouldNotify(muted(), { mentioned: ['aci-me'] }), true);
    assert.equal(store.shouldNotify(muted({ mentionsIfMuted: false }), { mentioned: ['aci-me'] }), false);
    config.set({ notifyMentionsIfMuted: false });
    assert.equal(store.shouldNotify(muted(), { mentioned: ['aci-me'] }), false);
    assert.equal(store.shouldNotify(muted({ mentionsIfMuted: true }), { mentioned: ['aci-me'] }), true);
    config.set({ notifyMentionsIfMuted: undefined });
    assert.equal(store.shouldNotify({ ...muted(), type: 'direct' }, { mentioned: ['aci-me'] }), false);
  });

  it('lets replies through muted groups and calls through only when turned on, per chat or for the account', () => {
    const muted = (extra: Partial<Conversation> = {}) => group({ mutedUntil: store.MUTED_ALWAYS, ...extra });
    const direct = (extra: Partial<Conversation> = {}) => ({ ...muted(extra), type: 'direct' as const });
    assert.equal(store.shouldNotify(muted(), { reply: true }), true);
    assert.equal(store.shouldNotify(muted({ repliesIfMuted: false }), { reply: true }), false);
    assert.equal(store.shouldNotify(direct(), { reply: true }), false);
    assert.equal(store.shouldNotify(muted(), { call: true }), false);
    assert.equal(store.shouldNotify(direct({ callsIfMuted: true }), { call: true }), true);
    config.set({ notifyCallsIfMuted: true, notifyRepliesIfMuted: false });
    assert.equal(store.shouldNotify(muted(), { call: true }), true);
    assert.equal(store.shouldNotify(muted({ callsIfMuted: false }), { call: true }), false);
    assert.equal(store.shouldNotify(muted(), { reply: true }), false);
    config.set({ notifyCallsIfMuted: undefined, notifyRepliesIfMuted: undefined });
    assert.equal(store.shouldNotify(group({ mutedUntil: Date.now() - 1 })), true);
  });

  it('follows notification profiles: schedules past midnight, the manual switch, and who they let through', () => {
    const local = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();
    const sleep: store.NotificationProfile = { id: 'c2xlZXA=', name: 'Sleep', emoji: '', createdAt: 1, allowAllCalls: true, allowAllMentions: false, allowed: ['g:X'], schedule: { start: 2200, end: 700, days: [3] } };
    const work: store.NotificationProfile = { id: 'd29yaw==', name: 'Work', emoji: '', createdAt: 2, allowAllCalls: false, allowAllMentions: true, allowed: [], schedule: null };
    // 11 Nov 2026 is a Wednesday (3).
    assert.equal(store.scheduleStart(sleep, local(11, 23)), local(11, 22));
    assert.equal(store.scheduleStart(sleep, local(12, 6, 59)), local(11, 22));
    assert.equal(store.scheduleStart(sleep, local(12, 7)), 0);
    assert.equal(store.scheduleStart(sleep, local(12, 23)), 0);

    config.set({ notificationProfiles: [sleep, work], notificationProfileOverride: null });
    assert.equal(store.activeProfile(local(11, 23))!.name, 'Sleep');
    config.set({ notificationProfileOverride: { disabledAt: local(11, 22, 30) } });
    assert.equal(store.activeProfile(local(11, 23)), null);
    config.set({ notificationProfileOverride: { enabledId: work.id, endAt: local(11, 23, 30) } });
    assert.equal(store.activeProfile(local(11, 23))!.name, 'Work');
    assert.equal(store.activeProfile(local(11, 23, 45))!.name, 'Sleep');

    config.set({ notificationProfileOverride: { enabledId: sleep.id, endAt: 0 } });
    assert.equal(store.shouldNotify(group()), true);
    assert.equal(store.shouldNotify(group({ id: 'g:Y' })), false);
    assert.equal(store.shouldNotify(group({ id: 'g:Y' }), { call: true }), true);
    assert.equal(store.shouldNotify(group({ mutedUntil: store.MUTED_ALWAYS })), false);
    config.set({ notificationProfileOverride: { enabledId: work.id, endAt: 0 } });
    assert.equal(store.shouldNotify(group({ id: 'g:Y' }), { mentioned: ['aci-me'] }), true);
    assert.equal(store.shouldNotify(group({ id: 'g:Y' }), { call: true }), false);
    config.set({ notificationProfiles: undefined, notificationProfileOverride: undefined });
  });

  it('hides the sender or the message when Show says so', () => {
    const g = group({ name: 'Team' });
    assert.deepEqual(store.notificationText(g, 'Dave: hi'), { title: 'Team', body: 'Dave: hi' });
    config.set({ notifyShow: 'name' });
    assert.deepEqual(store.notificationText(g, 'Dave: hi'), { title: 'Team', body: 'New message' });
    config.set({ notifyShow: 'none' });
    assert.deepEqual(store.notificationText(g, 'Dave: hi'), { title: 'Beacon', body: 'New message' });
    config.set({ notifyShow: undefined });
  });

  it('reads who a message mentions', () => {
    const evs = parseFrame({ envelope: { sourceNumber: '+15550009', sourceUuid: 'aci-x', timestamp: 10, dataMessage: { timestamp: 10, message: '\ufffc hi', mentions: [{ start: 0, length: 1, uuid: 'aci-me' }], groupInfo: { groupId: 'R1JQ' } } } }, ME, () => 'Me');
    assert.deepEqual((evs[0] as any).mentioned, ['aci-me']);
  });

  it('syncs the setting both ways', async () => {
    const synced: any[] = [];
    (signal as any).syncChatState = async (s: any) => {
      synced.push(s);
    };
    store.ingestRaw({ envelope: { sourceNumber: '+15550009', sourceUuid: 'aci-x', timestamp: 20, dataMessage: { timestamp: 20, message: 'hi', groupInfo: { groupId: 'TUVO' } } } });
    await settle();
    const conv = store.conversation('g:TUVO')!;
    conv.sendId = 'group.TUVO';
    store.setMuted(conv.id, store.MUTED_ALWAYS);
    store.setNotifyIfMuted(conv.id, 'mentions', false);
    assert.equal(conv.mentionsIfMuted, false);
    assert.deepEqual(synced[synced.length - 1], { type: 'group', sendId: 'group.TUVO', mentionsIfMuted: false });
    store.setNotifyIfMuted(conv.id, 'mentions', false);
    assert.equal(synced.filter((s) => 'mentionsIfMuted' in s).length, 1);
    store.setNotifyIfMuted(conv.id, 'calls', true);
    assert.deepEqual(synced[synced.length - 1], { type: 'group', sendId: 'group.TUVO', callsIfMuted: true });

    store.applyChatState([{ groupInternalId: 'TUVO', archived: false, mentionsIfMuted: true, repliesIfMuted: false }], null);
    assert.equal(conv.mentionsIfMuted, true);
    assert.equal(conv.repliesIfMuted, false);
    store.applyChatState([{ groupInternalId: 'TUVO', archived: false, mentionsIfMuted: null, repliesIfMuted: null }], null);
    assert.equal(conv.mentionsIfMuted, undefined);
    assert.equal(store.notifiesWhileMuted(conv, 'mentions'), true);
    assert.equal(store.notifiesWhileMuted(conv, 'replies'), true);
  });
});

describe('text size', () => {
  it('scales the root font size and keeps the choice', () => {
    const root = { style: { fontSize: '' }, setAttribute() {} };
    const doc = (globalThis as any).document;
    doc.documentElement = root;
    doc.querySelector = () => null;
    applyTheme();
    assert.equal(root.style.fontSize, '10px');
    setTextSize('xlarge');
    assert.equal(root.style.fontSize, TEXT_SIZE_PX.xlarge + 'px');
    assert.equal(config.textSize(), 'xlarge');
    setTextSize('small');
    assert.equal(root.style.fontSize, '9px');
    config.set({ textSize: 'huge' as any });
    assert.equal(config.textSize(), 'normal');
  });
});

describe('blurhash placeholders', () => {
  it('puts a sent photo’s hash and size on its pointer and drops bad ones', () => {
    const ptr = create(AttachmentPointerSchema, { contentType: 'image/jpeg' });
    applyAttachmentMeta(ptr, { blurHash: HASH, width: 1200, height: 900 });
    assert.equal(ptr.blurHash, HASH);
    assert.equal(ptr.width, 1200);
    assert.equal(ptr.height, 900);

    const bad = create(AttachmentPointerSchema, { contentType: 'image/jpeg' });
    applyAttachmentMeta(bad, { blurHash: 'not a hash!', width: -1, height: 5 });
    assert.equal(bad.blurHash, '');
    assert.equal(bad.width, 0);

    const file = create(AttachmentPointerSchema, { contentType: 'application/pdf' });
    applyAttachmentMeta(file, { blurHash: HASH });
    assert.equal(file.blurHash, '');
  });

  it('reads received hashes and draws them', () => {
    assert.deepEqual(receivedMeta(create(AttachmentPointerSchema, { contentType: 'video/mp4', blurHash: HASH, width: 640, height: 360 })), { blurHash: HASH, width: 640, height: 360 });
    assert.deepEqual(receivedMeta(create(AttachmentPointerSchema, { contentType: 'image/png', blurHash: 'x"><script>' })), {});

    const size = placeholderSize(1200, 600);
    assert.ok(size.width > size.height);
    assert.ok(Math.abs(size.width * size.height - 1024) < 100);
    assert.deepEqual(placeholderSize(), { width: 32, height: 32 });
    const px = hashToPixels(HASH, size.width, size.height)!;
    assert.equal(px.length, size.width * size.height * 4);
    assert.equal(hashToPixels('zz', 4, 4), null);

    const red = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < red.length; i += 4) red.set([200, 30, 30, 255], i);
    const hash = hashPixels(red, 4, 4);
    const back = hashToPixels(hash, 2, 2)!;
    assert.ok(back[0] > 150 && back[1] < 80 && back[2] < 80);
  });

  it('keeps the hash through sending and receiving', async () => {
    const sent: any[] = [];
    (signal as any).send = async (payload: any) => {
      sent.push(payload);
      return { timestamp: 30 };
    };
    store.ingestRaw({ envelope: { sourceNumber: '+15550009', sourceUuid: 'aci-x', timestamp: 40, dataMessage: { timestamp: 40, attachments: [{ id: 'p', contentType: 'image/jpeg', blurHash: HASH, width: 800, height: 600 }] } } });
    await settle();
    const got = (await db.getMessage('+15550009|40|+15550009'))!.attachments[0];
    assert.equal(got.blurHash, HASH);
    assert.equal(got.width, 800);

    const rec = await store.sendAttachments('+15550009', [{ dataUri: 'data:image/jpeg;base64,AAAA', contentType: 'image/jpeg', filename: 'a.jpg', size: 3, blurHash: HASH, width: 10, height: 20 }], '');
    assert.deepEqual(sent[0].attachment_meta, [{ blurHash: HASH, width: 10, height: 20 }]);
    assert.equal(rec.attachments[0].blurHash, HASH);
  });
});
