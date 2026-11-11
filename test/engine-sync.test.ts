import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { concatBytes, toBase64, uuidToBytes } from '../src/engine/bytes';
import { ContactDetailsSchema, ContentSchema, DataMessage_Flags, DataMessage_Payment_Activation_Type, SyncMessage_MessageRequestResponse_Type } from '../src/engine/gen/SignalService_pb';
import { create, serviceIdFrom, toBinary } from '../src/engine/net/proto';
import { MemorySignalStore } from '../src/engine/protocol/store';
import { ALICE, BOB } from './helpers';
import { loadWasmForTests } from './support';
import { contentToNormalizedFrame, decodeAttachmentDescriptor } from '../src/engine/net/incoming-json';
import { parseContactsSyncBlob } from '../src/engine/net/receive';
import { reportSpam } from '../src/engine/services/report-spam';

before(() => {
  loadWasmForTests();
});

describe('Sync and service IDs', () => {
  it('parses delimited ContactDetails records and skips inline avatars', () => {
    const record = (init: any) => {
      const bytes = toBinary(ContactDetailsSchema, create(ContactDetailsSchema, init));
      return concatBytes(new Uint8Array([bytes.length]), bytes);
    };
    const blob = concatBytes(
      record({ aci: ALICE, number: '+15550001111', name: 'Alice', avatar: { contentType: 'image/jpeg', length: 4 } }),
      new Uint8Array([1, 2, 3, 4]),
      record({ aciBinary: uuidToBytes('22222222-2222-4222-8222-222222222222'), expireTimer: 60 })
    );
    const contacts = parseContactsSyncBlob(blob);
    assert.equal(contacts.length, 2);
    assert.equal(contacts[0].name, 'Alice');
    assert.equal(contacts[1].uuid, '22222222-2222-4222-8222-222222222222');
    assert.equal(contacts[1].expireTimer, 60);
  });

  it('turns pin, unpin, and timer-update data messages into normalize frames', () => {
    const env = { sourceUuid: BOB, sourceDevice: 1, timestamp: 1000 } as any;
    const frame = (dm: any) => contentToNormalizedFrame(env, create(ContentSchema, { content: { case: 'dataMessage', value: dm } })).envelope.dataMessage;
    const ref = { targetAuthorAciBinary: uuidToBytes(ALICE), targetSentTimestamp: 42n };
    assert.deepEqual(frame({ timestamp: 1000n, pinMessage: { ...ref, pinDuration: { case: 'pinDurationForever', value: true } } }).pinMessage, {
      targetAuthorUuid: ALICE,
      targetSentTimestamp: 42,
    });
    const unpin = frame({ timestamp: 1000n, unpinMessage: ref });
    assert.equal(unpin.pinMessage, undefined);
    assert.equal(unpin.unpinMessage.targetSentTimestamp, 42);
    const timer = frame({ timestamp: 1000n, flags: DataMessage_Flags.EXPIRATION_TIMER_UPDATE, expireTimer: 3600, expireTimerVersion: 3 });
    assert.equal(timer.expirationTimerUpdate, true);
    assert.equal(timer.expiresInSeconds, 3600);
    const quoted = frame({ timestamp: 1000n, body: 'nice', quote: { id: 7n, authorAci: ALICE, text: '', attachments: [{ contentType: 'image/jpeg', fileName: 'a.jpg' }] } });
    assert.deepEqual(quoted.quote, { id: 7, authorUuid: ALICE, text: '', attachments: [{ contentType: 'image/jpeg', filename: 'a.jpg' }] });
  });

  it('keeps only the kind of a payment and which story a reply is about', () => {
    const env = { sourceUuid: BOB, sourceDevice: 1, timestamp: 1000 } as any;
    const frame = (dm: any) => contentToNormalizedFrame(env, create(ContentSchema, { content: { case: 'dataMessage', value: dm } })).envelope.dataMessage;
    const paid = frame({ timestamp: 1000n, payment: { Item: { case: 'notification', value: { note: 'rent', Transaction: { case: 'mobileCoin', value: { receipt: new Uint8Array([9, 9, 9]) } } } } } });
    assert.deepEqual(paid.payment, { kind: 'notification' });
    assert.equal(JSON.stringify(paid).includes('rent'), false);
    const activation = (type: DataMessage_Payment_Activation_Type) => frame({ timestamp: 1000n, payment: { Item: { case: 'activation', value: { type } } } }).payment;
    assert.deepEqual(activation(DataMessage_Payment_Activation_Type.REQUEST), { kind: 'activationRequest' });
    assert.deepEqual(activation(DataMessage_Payment_Activation_Type.ACTIVATED), { kind: 'activated' });
    assert.equal(frame({ timestamp: 1000n, payment: {} }).payment, undefined);
    const reply = frame({ timestamp: 1000n, body: 'love it', storyContext: { authorAciBinary: uuidToBytes(ALICE), sentTimestamp: 77n } });
    assert.deepEqual(reply.storyContext, { authorUuid: ALICE, sentTimestamp: 77 });
    assert.equal(reply.message, 'love it');
  });

  it('turns polls, votes, and poll ends into normalize frames within Signal-Desktop limits', () => {
    const env = { sourceUuid: BOB, sourceDevice: 1, timestamp: 1000 } as any;
    const frame = (dm: any) => contentToNormalizedFrame(env, create(ContentSchema, { content: { case: 'dataMessage', value: dm } })).envelope.dataMessage;
    assert.deepEqual(frame({ timestamp: 1000n, pollCreate: { question: 'Lunch?', options: ['Pizza', 'Soup'], allowMultiple: true } }).pollCreate, { question: 'Lunch?', options: ['Pizza', 'Soup'], allowMultiple: true });
    assert.equal(frame({ timestamp: 1000n, pollCreate: { question: 'Lunch?', options: ['Pizza'] } }).pollCreate, undefined);
    assert.equal(frame({ timestamp: 1000n, pollCreate: { question: 'x'.repeat(201), options: ['a', 'b'] } }).pollCreate, undefined);
    assert.ok(frame({ timestamp: 1000n, pollCreate: { question: '👋🏽'.repeat(200), options: ['a', 'b'] } }).pollCreate);
    assert.equal(frame({ timestamp: 1000n, pollCreate: { question: 'q', options: Array.from({ length: 11 }, (_, i) => 'o' + i) } }).pollCreate, undefined);
    assert.deepEqual(frame({ timestamp: 1000n, pollVote: { targetAuthorAciBinary: uuidToBytes(ALICE), targetSentTimestamp: 42n, optionIndexes: [1, 0], voteCount: 3 } }).pollVote, {
      targetAuthorUuid: ALICE,
      targetSentTimestamp: 42,
      optionIndexes: [1, 0],
      voteCount: 3,
    });
    assert.equal(frame({ timestamp: 1000n, pollVote: { targetAuthorAciBinary: uuidToBytes(ALICE), targetSentTimestamp: 42n, optionIndexes: [10], voteCount: 1 } }).pollVote, undefined);
    assert.deepEqual(frame({ timestamp: 1000n, pollTerminate: { targetSentTimestamp: 42n } }).pollTerminate, { targetSentTimestamp: 42 });
  });

  it('keeps a link preview only for a safe https link in the message text, as Signal-Desktop does', () => {
    const guid = '0f6c2a1e-4b7d-4c3a-9a8e-2d1f5b6c7e8f';
    const env = { sourceUuid: BOB, sourceDevice: 1, timestamp: 1000, serverGuid: guid.toUpperCase(), reportSpamToken: new Uint8Array([1, 2, 3]) } as any;
    const out = (dm: any) => contentToNormalizedFrame(env, create(ContentSchema, { content: { case: 'dataMessage', value: { timestamp: 1000n, ...dm } } })).envelope;
    const image = { attachmentIdentifier: { case: 'cdnKey' as const, value: 'k' }, cdnNumber: 2, key: new Uint8Array(64), contentType: 'image/jpeg', size: 1234 };
    const shown = out({ body: 'look (https://signal.org/blog/a?b=1).', preview: [{ url: 'https://signal.org/blog/a?b=1', title: 'Blog', description: 'Post', image }] });
    assert.equal(shown.serverGuid, guid);
    assert.equal(shown.reportSpamToken, 'AQID');
    const p = shown.dataMessage.preview;
    assert.deepEqual([p.url, p.title, p.description, p.image.contentType, p.image.size], ['https://signal.org/blog/a?b=1', 'Blog', 'Post', 'image/jpeg', 1234]);
    assert.ok(decodeAttachmentDescriptor(p.image.id));

    const dropped = (url: string, body = 'see ' + url) => assert.equal(out({ body, preview: [{ url, title: 'T' }] }).dataMessage.preview, undefined, url);
    dropped('https://signal.org/other', 'see https://signal.org/blog');
    dropped('http://signal.org/');
    dropped('https://user:pw@signal.org/');
    dropped('https://localhost/x');
    dropped('https://www.example.com/');
    dropped('https://xn--sgnal-m3a.org/');
    dropped('https://signal.org/aquí');
    dropped('https://signal.org/', 'see \u202ehttps://signal.org/');
    assert.equal(out({ body: 'https://signal.org/', preview: [{ url: 'https://signal.org/' }] }).dataMessage.preview, undefined);
    assert.equal(out({ body: 'hi' }).dataMessage.preview, undefined);
  });

  it('reports spam with POST /v1/messages/report/{aci}/{guid} and the reporting token', async () => {
    const calls: any[] = [];
    const httpJson = (async (method: string, path: string, body: any, opts: any) => {
      calls.push({ method, path, body, user: opts.basicAuth.username });
    }) as any;
    const store = new MemorySignalStore({ aci: ALICE, number: '', deviceId: 3, password: 'pw', registrationId: 1, pniRegistrationId: 2, aciIdentityKeyPair: { pubKey: new Uint8Array(33), privKey: new Uint8Array(32) } } as any);
    const g1 = '0f6c2a1e-4b7d-4c3a-9a8e-2d1f5b6c7e8f';
    const g2 = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
    assert.equal(await reportSpam(store, httpJson, BOB, [g1, 'not-a-guid', g2], 'AQID'), 2);
    assert.deepEqual(calls, [
      { method: 'POST', path: `/v1/messages/report/${BOB}/${g1}`, body: { token: 'AQID' }, user: ALICE + '.3' },
      { method: 'POST', path: `/v1/messages/report/${BOB}/${g2}`, body: { token: 'AQID' }, user: ALICE + '.3' },
    ]);
    calls.length = 0;
    await reportSpam(store, httpJson, BOB, [g1]);
    assert.deepEqual(calls[0].body, {});
    await assert.rejects(reportSpam(store, httpJson, 'PNI:' + BOB, [g1]));
  });

  it('reduces shared contacts to a name, numbers, and emails', () => {
    const env = { sourceUuid: BOB, sourceDevice: 1, timestamp: 1000 } as any;
    const dm = contentToNormalizedFrame(
      env,
      create(ContentSchema, {
        content: {
          case: 'dataMessage',
          value: {
            timestamp: 1000n,
            contact: [
              { name: { givenName: 'Clara', familyName: 'Oswald' }, number: [{ value: '+15550123' }, { value: '' }], email: [{ value: 'clara@example.com' }] },
              { organization: 'TARDIS Ltd' },
            ],
          },
        },
      })
    ).envelope.dataMessage;
    assert.deepEqual(dm.contacts, [
      { name: 'Clara Oswald', phones: ['+15550123'], emails: ['clara@example.com'] },
      { name: 'TARDIS Ltd', phones: [], emails: [] },
    ]);
  });

  it('turns viewed and view-once-open syncs into normalize frames', () => {
    const env = { sourceUuid: BOB, sourceDevice: 2, timestamp: 1000 } as any;
    const sync = contentToNormalizedFrame(
      env,
      create(ContentSchema, {
        content: {
          case: 'syncMessage',
          value: { viewed: [{ senderAciBinary: uuidToBytes(ALICE), timestamp: 5n }], content: { case: 'viewOnceOpen', value: { senderAci: ALICE, timestamp: 6n } } },
        },
      })
    ).envelope.syncMessage;
    assert.deepEqual(sync.viewedMessages, [{ sender: ALICE, senderUuid: ALICE, timestamp: 5 }]);
    assert.deepEqual(sync.viewOnceOpen, { sender: ALICE, senderUuid: ALICE, timestamp: 6 });
  });

  it('turns admin deletes and delete-for-me syncs into normalize frames', () => {
    const env = { sourceUuid: BOB, sourceDevice: 2, timestamp: 1000 } as any;
    const dm = contentToNormalizedFrame(
      env,
      create(ContentSchema, { content: { case: 'dataMessage', value: { timestamp: 1000n, adminDelete: { targetAuthorAciBinary: uuidToBytes(ALICE), targetSentTimestamp: 900n } } } })
    ).envelope.dataMessage;
    assert.deepEqual(dm.adminDelete, { targetAuthorUuid: ALICE, targetSentTimestamp: 900 });

    const groupId = new Uint8Array(32).fill(7);
    const sync = contentToNormalizedFrame(
      env,
      create(ContentSchema, {
        content: {
          case: 'syncMessage',
          value: {
            content: {
              case: 'deleteForMe',
              value: {
                messageDeletes: [{ conversation: { identifier: { case: 'threadServiceId', value: ALICE } }, messages: [{ author: { case: 'authorServiceIdBinary', value: uuidToBytes(ALICE) }, sentTimestamp: 5n }] }],
                conversationDeletes: [{ conversation: { identifier: { case: 'threadGroupId', value: groupId } }, mostRecentMessages: [{ author: { case: 'authorE164', value: '+15550001' }, sentTimestamp: 6n }], isFullDelete: true }],
                localOnlyConversationDeletes: [{ conversation: { identifier: { case: 'threadE164', value: '+15550002' } } }],
              },
            },
          },
        },
      })
    ).envelope.syncMessage;
    assert.deepEqual(sync.deleteForMe, {
      messages: [{ conversation: { uuid: ALICE }, messages: [{ author: ALICE, timestamp: 5 }] }],
      conversations: [
        { conversation: { groupId: toBase64(groupId) }, mostRecent: [{ author: '+15550001', timestamp: 6 }], mostRecentNonExpiring: [], isFullDelete: true },
        { conversation: { number: '+15550002' }, mostRecent: [], mostRecentNonExpiring: [], isFullDelete: true },
      ],
    });
  });

  it('turns message request responses into normalize frames', () => {
    const env = { sourceUuid: BOB, sourceDevice: 2, timestamp: 1000 } as any;
    const frame = (value: any) => contentToNormalizedFrame(env, create(ContentSchema, { content: { case: 'syncMessage', value: { content: { case: 'messageRequestResponse', value } } } })).envelope.syncMessage.messageRequestResponse;
    assert.deepEqual(frame({ threadAciBinary: uuidToBytes(ALICE), type: SyncMessage_MessageRequestResponse_Type.BLOCK_AND_DELETE }), { threadUuid: ALICE, groupId: undefined, type: 'blockAndDelete' });
    assert.deepEqual(frame({ threadAci: ALICE, type: SyncMessage_MessageRequestResponse_Type.ACCEPT }), { threadUuid: ALICE, groupId: undefined, type: 'accept' });
    assert.equal(frame({ threadAci: ALICE }).type, 'unknown');
  });

  it('reads service IDs from strings or 16/17-byte binaries', () => {
    const raw = uuidToBytes(ALICE);
    assert.equal(serviceIdFrom(undefined, raw), ALICE);
    assert.equal(serviceIdFrom(undefined, concatBytes(new Uint8Array([1]), raw)), 'PNI:' + ALICE);
    assert.equal(serviceIdFrom('PNI:x', raw), 'PNI:x');
    assert.equal(serviceIdFrom(undefined, new Uint8Array(5)), '');
  });
});
