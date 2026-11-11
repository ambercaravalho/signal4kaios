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

const ME = '+15550000';
const HASH = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';

function settle(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
    assert.equal(store.shouldNotify(group()), true);
    assert.equal(store.shouldNotify(group({ muted: true })), false);
    assert.equal(store.shouldNotify(group({ muted: true }), ['aci-other']), false);
    assert.equal(store.shouldNotify(group({ muted: true }), ['aci-me']), true);
    assert.equal(store.shouldNotify(group({ muted: true, mentionsIfMuted: false }), ['aci-me']), false);
    config.set({ notifyMentionsIfMuted: false });
    assert.equal(store.shouldNotify(group({ muted: true }), ['aci-me']), false);
    assert.equal(store.shouldNotify(group({ muted: true, mentionsIfMuted: true }), ['aci-me']), true);
    config.set({ notifyMentionsIfMuted: undefined });
    assert.equal(store.shouldNotify({ ...group({ muted: true }), type: 'direct' }, ['aci-me']), false);
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
    store.setMuted(conv.id, true);
    store.setMentionsIfMuted(conv.id, false);
    assert.equal(conv.mentionsIfMuted, false);
    assert.deepEqual(synced[synced.length - 1], { type: 'group', sendId: 'group.TUVO', mentionsIfMuted: false });
    store.setMentionsIfMuted(conv.id, false);
    assert.equal(synced.filter((s) => 'mentionsIfMuted' in s).length, 1);

    store.applyChatState([{ groupInternalId: 'TUVO', archived: false, mentionsIfMuted: true }], null);
    assert.equal(conv.mentionsIfMuted, true);
    store.applyChatState([{ groupInternalId: 'TUVO', archived: false, mentionsIfMuted: null }], null);
    assert.equal(conv.mentionsIfMuted, undefined);
    assert.equal(store.mentionsNotifyWhileMuted(conv), true);
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
