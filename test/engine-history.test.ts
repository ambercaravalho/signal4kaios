/* Link-and-sync: an archive built the way Signal-Desktop exports one, read back through the two-pass import and the frame mapper, plus the transfer archive poll and the ranged download. */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { randomBytes, uuidToBytes } from '../src/engine/bytes';
import { BackupInfoSchema, BodyRange_Style, FrameSchema } from '../src/engine/gen/Backups_pb';
import { decodeAttachmentDescriptor } from '../src/engine/net/attachment-descriptor';
import { create, toBinary } from '../src/engine/net/proto';
import { libsignal } from '../src/engine/protocol/libsignal';
import { CHUNK_BYTES, downloadArchive, rangeTotal } from '../src/engine/services/history/download';
import { createFrameMapper } from '../src/engine/services/history/frames';
import { importArchive } from '../src/engine/services/history/import';
import { parseTransferArchive, waitForTransferArchive } from '../src/engine/services/history/transfer';
import type { HistoryItem, HistoryMessage } from '../src/engine/services/history/types';
import { ALICE, BOB } from './helpers';
import { loadWasmForTests } from './support';

before(() => {
  loadWasmForTests();
});

const NOW = 1_700_000_000_000;
const BOB_NUMBER = '+15550001111';
const groupIdOf = (mk: Uint8Array) => 'grp' + mk[0];

function varint(n: number): Uint8Array {
  const out: number[] = [];
  for (; n > 0x7f; n >>>= 7) out.push((n & 0x7f) | 0x80);
  out.push(n);
  return Uint8Array.from(out);
}

/** Delimited frames, gzip, AES-256-CBC, then an HMAC over iv and ciphertext, as Signal-Desktop's export writes them. */
function archive(backupKey: Uint8Array, frames: Uint8Array[]): Uint8Array {
  const keys = libsignal.messageBackupKey(backupKey, ALICE) as { hmacKey: Uint8Array; aesKey: Uint8Array };
  const plain = Buffer.concat(frames.flatMap((f) => [varint(f.length), f]));
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', keys.aesKey, iv);
  const body = Buffer.concat([iv, cipher.update(gzipSync(plain)), cipher.final()]);
  return new Uint8Array(Buffer.concat([body, createHmac('sha256', keys.hmacKey).update(body).digest()]));
}

const frame = (item: any) => toBinary(FrameSchema, create(FrameSchema, { item }));
const info = (version = 1n) => toBinary(BackupInfoSchema, create(BackupInfoSchema, { version, backupTimeMs: BigInt(NOW) }));
const text = (body: string, bodyRanges: any[] = []) => ({ body, bodyRanges });
const incoming = { case: 'incoming', value: { dateReceived: 1n, read: true } };

function transitPointer(integrity: any) {
  return { contentType: 'image/jpeg', fileName: 'a.jpg', width: 4, height: 3, locatorInfo: { key: new Uint8Array(64).fill(7), size: 1234, transitCdnKey: 'cdnkey', transitCdnNumber: 3, integrityCheck: integrity } };
}

function sampleFrames(): Uint8Array[] {
  const groupKey = new Uint8Array(32).fill(9);
  return [
    info(),
    frame({ case: 'recipient', value: { id: 1n, destination: { case: 'self', value: {} } } }),
    frame({ case: 'recipient', value: { id: 2n, destination: { case: 'contact', value: { aci: uuidToBytes(BOB), e164: 15550001111n, profileGivenName: 'Bob', profileKey: new Uint8Array(32).fill(1), profileSharing: true } } } }),
    frame({ case: 'recipient', value: { id: 3n, destination: { case: 'group', value: { masterKey: groupKey, whitelisted: true, snapshot: { title: { content: { case: 'title', value: 'Book club' } } } } } } }),
    frame({ case: 'chat', value: { id: 10n, recipientId: 2n, pinnedOrder: 1, muteUntilMs: 9223372036854775807n, expirationTimerMs: 3600000n } }),
    frame({ case: 'chat', value: { id: 11n, recipientId: 3n } }),
    frame({
      case: 'chatItem',
      value: {
        chatId: 10n,
        authorId: 2n,
        dateSent: 1000n,
        directionalDetails: incoming,
        revisions: [{ chatId: 10n, authorId: 2n, dateSent: 900n, directionalDetails: incoming, item: { case: 'standardMessage', value: { text: text('helo') } } }],
        item: {
          case: 'standardMessage',
          value: {
            text: text('hello', [{ start: 0, length: 5, associatedValue: { case: 'style', value: BodyRange_Style.BOLD } }]),
            attachments: [{ pointer: transitPointer({ case: 'plaintextHash', value: new Uint8Array(32).fill(5) }) }, { pointer: { contentType: 'image/png', locatorInfo: { key: new Uint8Array(64), size: 9 } } }],
            reactions: [{ emoji: '👍', authorId: 1n, sentTimestamp: 1n, sortOrder: 1n }],
          },
        },
      },
    }),
    frame({
      case: 'chatItem',
      value: {
        chatId: 10n,
        authorId: 1n,
        dateSent: 2000n,
        directionalDetails: { case: 'outgoing', value: { sendStatus: [{ recipientId: 2n, deliveryStatus: { case: 'delivered', value: {} } }, { recipientId: 2n, deliveryStatus: { case: 'read', value: {} } }] } },
        item: { case: 'standardMessage', value: { text: text('re'), quote: { targetSentTimestamp: 1000n, authorId: 2n, text: text('hello') } } },
      },
    }),
    frame({ case: 'chatItem', value: { chatId: 10n, authorId: 2n, dateSent: 3000n, expireStartDate: 1n, expiresInMs: 10n, directionalDetails: incoming, item: { case: 'standardMessage', value: { text: text('gone') } } } }),
    frame({ case: 'chatItem', value: { chatId: 10n, authorId: 2n, dateSent: 4000n, directionalDetails: { case: 'directionless', value: {} }, item: { case: 'updateMessage', value: { update: { case: 'expirationTimerChange', value: { expiresInMs: 3600000n } } } } } }),
    frame({
      case: 'chatItem',
      value: {
        chatId: 11n,
        authorId: 1n,
        dateSent: 5000n,
        directionalDetails: { case: 'directionless', value: {} },
        item: { case: 'updateMessage', value: { update: { case: 'groupChange', value: { updates: [{ update: { case: 'groupNameUpdate', value: { updaterAci: uuidToBytes(BOB), newGroupName: 'Books' } } }] } } } },
      },
    }),
    frame({ case: 'stickerPack', value: { packId: new Uint8Array(16), packKey: new Uint8Array(32) } }),
  ];
}

function mapAll(frames: Uint8Array[]): HistoryItem[] {
  const mapper = createFrameMapper({ aci: ALICE, e164: '+15553334444' }, groupIdOf, NOW);
  return frames.map((f) => mapper.map(f)).filter((x): x is HistoryItem => !!x);
}

describe('link-and-sync frames (Signal-Desktop backups/import)', () => {
  it('maps people, chats, and messages, and skips expired items and records Storage supplies', () => {
    const items = mapAll(sampleFrames());
    assert.deepEqual(items.map((i) => i.t), ['contact', 'group', 'chat', 'chat', 'message', 'message', 'message', 'message']);
    const [bob, group, chat, groupChat] = items as any[];
    assert.deepEqual([bob.aci, bob.e164, bob.name, bob.whitelisted], [BOB, BOB_NUMBER, 'Bob', true]);
    assert.equal(bob.profileKey, Buffer.from(new Uint8Array(32).fill(1)).toString('base64'));
    assert.deepEqual([group.groupId, group.title, group.whitelisted], ['grp9', 'Book club', true]);
    assert.deepEqual([chat.convId, chat.pinned, chat.mutedUntil, chat.expireTimer], [BOB_NUMBER, true, Number.MAX_SAFE_INTEGER, 3600]);
    assert.deepEqual([groupChat.convId, groupChat.groupInternalId], ['g:grp9', 'grp9']);

    const [first, reply, timer, change] = items.slice(4) as HistoryMessage[];
    assert.equal(first.author, BOB_NUMBER);
    assert.equal(first.incoming, true);
    assert.equal(first.dm.message, 'hello');
    assert.deepEqual(first.dm.textStyles, [{ start: 0, length: 5, style: 'BOLD' }]);
    assert.deepEqual(first.reactions, { '+15553334444': '👍' });
    assert.deepEqual(first.revisions!.map((r: any) => [r.message, r.timestamp]), [['helo', 900]]);
    const desc = decodeAttachmentDescriptor(first.dm.attachments[0].id)!;
    assert.deepEqual([desc.cdnKey, desc.cdnNumber, desc.size, desc.digest, desc.plaintextHash!.length], ['cdnkey', 3, 1234, undefined, 32]);
    assert.equal(first.dm.attachments[1].id, '', 'an attachment with no CDN copy is asked of the phone');

    assert.equal(reply.incoming, false);
    assert.equal(reply.author, '+15553334444');
    assert.equal(reply.status, 'read');
    assert.deepEqual([reply.dm.quote.id, reply.dm.quote.authorNumber, reply.dm.quote.text], [1000, BOB_NUMBER, 'hello']);

    assert.deepEqual(timer.notice, { kind: 'timer', seconds: 3600 });
    assert.deepEqual(change.groupUpdates, [{ change: 'title', text: 'Books' }]);
    assert.equal(change.convId, 'g:grp9');
  });

  it('rejects an archive of another version, and throws on a frame that is not protobuf so the import can skip it', () => {
    assert.throws(() => mapAll([info(2n)]), (e: any) => e.name === 'BackupUnsupported');
    const mapper = createFrameMapper({ aci: ALICE, e164: '' }, groupIdOf, NOW);
    mapper.map(info());
    assert.throws(() => mapper.map(new Uint8Array([0xff, 0xff, 0xff])));
  });
});

describe('link-and-sync import (two passes)', () => {
  const chunked = (file: Uint8Array, size: number) => ({ count: Math.ceil(file.length / size), get: async (i: number) => file.subarray(i * size, (i + 1) * size) });

  it('checks the MAC first, then hands over every item in order', async () => {
    const key = randomBytes(32);
    const file = archive(key, sampleFrames());
    const got: HistoryItem[] = [];
    const passes: number[] = [];
    await importArchive(key, ALICE, chunked(file, 100), createFrameMapper({ aci: ALICE, e164: '+15553334444' }, groupIdOf, NOW), async (items) => { got.push(...items); }, (p) => passes.push(p), () => false);
    assert.equal(got.length, 8);
    assert.equal(passes.indexOf(2), passes.lastIndexOf(1) + 1, 'pass 2 starts after pass 1 ends');
  });

  it('imports nothing from a tampered archive, and stops when cancelled', async () => {
    const key = randomBytes(32);
    const file = archive(key, sampleFrames());
    file[file.length - 40] ^= 1;
    let items = 0;
    const mapper = createFrameMapper({ aci: ALICE, e164: '' }, groupIdOf, NOW);
    await assert.rejects(importArchive(key, ALICE, chunked(file, 64), mapper, async (x) => { items += x.length; }, () => {}, () => false), (e: any) => e.name === 'BackupBadMac');
    assert.equal(items, 0);
    await assert.rejects(importArchive(key, ALICE, chunked(archive(key, sampleFrames()), 64), mapper, async () => {}, () => {}, () => true), (e: any) => e.name === 'AbortError');
  });
});

describe('transfer archive and download', () => {
  it('reads the archive location or the phone\'s choice, and refuses anything else', () => {
    assert.deepEqual(parseTransferArchive({ cdn: 3, key: 'abc_DEF-1=' }), { cdn: 3, key: 'abc_DEF-1=' });
    assert.deepEqual(parseTransferArchive({ error: 'RELINK_REQUESTED' }), { error: 'RELINK_REQUESTED' });
    assert.deepEqual(parseTransferArchive({ error: 'CONTINUE_WITHOUT_UPLOAD' }), { error: 'CONTINUE_WITHOUT_UPLOAD' });
    assert.equal(parseTransferArchive(null), null);
    assert.throws(() => parseTransferArchive({ cdn: 3, key: '../etc' }));
    assert.throws(() => parseTransferArchive({ error: 'OTHER' }));
  });

  it('polls until the phone answers, and gives up after an hour', async () => {
    let calls = 0;
    const paths: string[] = [];
    const http = async (_m: string, path: string) => {
      paths.push(path);
      return ++calls < 3 ? null : { cdn: 2, key: 'k' };
    };
    assert.deepEqual(await waitForTransferArchive(http as any, 'https://chat', { username: 'u', password: 'p' }, () => false), { cdn: 2, key: 'k' });
    assert.ok(paths.every((p) => p === '/v1/devices/transfer_archive?timeout=300'));
    let t = 0;
    const late = async () => ((t += 31 * 60 * 1000), null);
    assert.equal(await waitForTransferArchive(late as any, 'https://chat', { username: 'u', password: 'p' }, () => false, () => t), null);
  });

  it('downloads in ranges from where it stopped', async () => {
    const total = CHUNK_BYTES * 2 + 10;
    const body = Uint8Array.from({ length: total }, (_, i) => i & 0xff);
    const ranges: string[] = [];
    const raw = async (_m: string, url: string, _b: unknown, headers: Record<string, string>) => {
      assert.equal(url, 'https://cdn3.signal.org/attachments/k');
      ranges.push(headers.Range);
      const [a, b] = /bytes=(\d+)-(\d+)/.exec(headers.Range)!.slice(1).map(Number);
      return { status: 206, body: body.subarray(a, b + 1), range: `bytes ${a}-${Math.min(b, total - 1)}/${total}` };
    };
    const saved = new Map<number, Uint8Array>();
    const sink = { put: async (i: number, bytes: Uint8Array) => { saved.set(i, bytes); } };
    assert.equal(await downloadArchive(raw as any, { cdn: 3, key: 'k' }, 1, sink, () => {}, () => false), 3);
    assert.deepEqual(ranges, [`bytes=${CHUNK_BYTES}-${CHUNK_BYTES * 2 - 1}`, `bytes=${CHUNK_BYTES * 2}-${CHUNK_BYTES * 3 - 1}`]);
    assert.deepEqual([...saved.keys()], [1, 2]);
    assert.equal(saved.get(2)!.length, 10);
    assert.equal(rangeTotal('bytes 0-9/2097162'), 2097162);
    assert.equal(rangeTotal('bytes 0-9/*'), 0);

    const whole = async () => ({ status: 200, body, range: null });
    saved.clear();
    assert.equal(await downloadArchive(whole as any, { cdn: 3, key: 'k' }, 0, sink, () => {}, () => false), 3, 'a server that ignores Range still fills every chunk');
    assert.equal(saved.get(0)!.length, CHUNK_BYTES);
    await assert.rejects(downloadArchive(whole as any, { cdn: 9, key: 'k' }, 0, sink, () => {}, () => false));
  });
});
