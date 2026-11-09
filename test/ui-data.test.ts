import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { expireLabel, fmtDuration, formatSafetyNumber, initials } from '../src/ui/data/format';
import { dbg, redactedLog } from '../src/ui/data/log';
import { applyMentions, parseFrame } from '../src/ui/data/normalize';
import { attachmentLabel, contactName } from '../src/ui/data/store';
import { emojiRuns, encodeMentions, isJumboEmoji, linkRuns, parseStyledMarkdown, SKIN_TONES, styleSegments, withSkinTone } from '../src/ui/data/styled';

const nameOf = (k: string) => (k === 'aci-bob' ? 'Bob' : k);

describe('parseFrame', () => {
  it('turns an incoming data message into a message event', () => {
    const evs = parseFrame({ envelope: { sourceNumber: '+15550001', sourceName: 'Alice', timestamp: 5, dataMessage: { timestamp: 10, message: 'hi', expiresInSeconds: 30 } } }, '+15559999', nameOf);
    assert.equal(evs.length, 1);
    const ev = evs[0];
    assert.equal(ev.type, 'message');
    if (ev.type !== 'message') return;
    assert.equal(ev.convId, '+15550001');
    assert.equal(ev.incoming, true);
    assert.equal(ev.timestamp, 10);
    assert.equal(ev.body, 'hi');
    assert.equal(ev.expiresInSeconds, 30);
  });

  it('routes group messages to the group chat', () => {
    const [ev] = parseFrame({ envelope: { sourceUuid: 'aci-bob', dataMessage: { message: 'yo', groupInfo: { groupId: 'GID' } } } }, '+1', nameOf);
    assert.equal(ev.type, 'message');
    if (ev.type === 'message') {
      assert.equal(ev.convId, 'g:GID');
      assert.equal(ev.groupInternalId, 'GID');
    }
  });

  it('attributes messages sent from another linked device to self', () => {
    const [ev] = parseFrame({ envelope: { sourceNumber: '+1', syncMessage: { sentMessage: { destinationNumber: '+2', timestamp: 7, message: 'sent elsewhere' } } } }, '+1', nameOf);
    assert.equal(ev.type, 'message');
    if (ev.type === 'message') {
      assert.equal(ev.convId, '+2');
      assert.equal(ev.incoming, false);
      assert.equal(ev.author, '+1');
    }
  });

  it('parses reactions, deletes, receipts, typing, and read syncs', () => {
    const env = { sourceNumber: '+3' };
    assert.equal(parseFrame({ envelope: { ...env, dataMessage: { reaction: { emoji: '👍', targetAuthorNumber: '+1', targetSentTimestamp: 9 } } } }, '+1', nameOf)[0].type, 'reaction');
    assert.equal(parseFrame({ envelope: { ...env, dataMessage: { remoteDelete: { timestamp: 9 } } } }, '+1', nameOf)[0].type, 'remoteDelete');
    const [rc] = parseFrame({ envelope: { ...env, receiptMessage: { isRead: true, timestamps: [1, 2] } } }, '+1', nameOf);
    assert.deepEqual(rc, { type: 'receipt', peer: '+3', kind: 'read', timestamps: [1, 2] });
    const [ty] = parseFrame({ envelope: { ...env, typingMessage: { action: 'STARTED' } } }, '+1', nameOf);
    assert.deepEqual(ty, { type: 'typing', convId: '+3', author: '+3', started: true });
    const [rs] = parseFrame({ envelope: { ...env, syncMessage: { readMessages: [{ senderNumber: '+4', timestamp: 3 }, { timestamp: 4 }] } } }, '+1', nameOf);
    assert.deepEqual(rs, { type: 'readSync', entries: [{ sender: '+4', timestamp: 3 }] });
  });

  it('keeps the first shared contact and drops empty ones', () => {
    const env = { sourceNumber: '+3', timestamp: 8 };
    const [ev] = parseFrame({ envelope: { ...env, dataMessage: { timestamp: 8, contacts: [{ name: 'Clara', phones: ['+1555', 7], emails: [] }] } } }, '+1', nameOf) as any[];
    assert.deepEqual(ev.contactCard, { name: 'Clara', phones: ['+1555'], emails: [] });
    assert.equal(ev.body, '');
    assert.deepEqual(parseFrame({ envelope: { ...env, dataMessage: { timestamp: 8, contacts: [{ name: '' }] } } }, '+1', nameOf), []);
  });

  it('counts viewed receipts as read and parses viewed and view-once syncs', () => {
    const env = { sourceNumber: '+3' };
    const [rc] = parseFrame({ envelope: { ...env, receiptMessage: { isViewed: true, timestamps: [7] } } }, '+1', nameOf);
    assert.deepEqual(rc, { type: 'receipt', peer: '+3', kind: 'read', timestamps: [7] });
    const evs = parseFrame({ envelope: { ...env, syncMessage: { viewedMessages: [{ senderUuid: 'aci-4', timestamp: 5 }], viewOnceOpen: { sender: 'aci-5', timestamp: 6 } } } }, '+1', nameOf);
    assert.deepEqual(evs, [
      { type: 'viewedSync', entries: [{ sender: 'aci-4', timestamp: 5 }], viewOnce: false },
      { type: 'viewedSync', entries: [{ sender: 'aci-5', timestamp: 6 }], viewOnce: true },
    ]);
  });

  it('parses admin deletes in groups and delete-for-me syncs', () => {
    const group = { groupInfo: { groupId: 'R1' } };
    const [ad] = parseFrame({ envelope: { sourceNumber: '+3', sourceUuid: 'aci-3', timestamp: 9, dataMessage: { ...group, timestamp: 9, adminDelete: { targetAuthorUuid: 'aci-4', targetSentTimestamp: 5 } } } }, '+1', nameOf);
    assert.deepEqual(ad, { type: 'adminDelete', convId: 'g:R1', admin: 'aci-3', targetAuthor: 'aci-4', targetTimestamp: 5, timestamp: 9 });
    assert.deepEqual(parseFrame({ envelope: { sourceNumber: '+3', sourceUuid: 'aci-3', dataMessage: { adminDelete: { targetAuthorUuid: 'aci-4', targetSentTimestamp: 5 } } } }, '+1', nameOf), []);

    const deleteForMe = {
      messages: [{ conversation: { uuid: 'aci-4' }, messages: [{ author: 'aci-4', timestamp: 5 }, { author: '', timestamp: 6 }] }, { conversation: {}, messages: [{ author: 'aci-4', timestamp: 7 }] }],
      conversations: [{ conversation: { groupId: 'R1' }, mostRecent: [{ author: '+1', timestamp: 8 }], mostRecentNonExpiring: [], isFullDelete: true }],
    };
    assert.deepEqual(parseFrame({ envelope: { sourceNumber: '+1', syncMessage: { deleteForMe } } }, '+1', nameOf), [
      {
        type: 'deleteSync',
        messages: [{ chat: { key: 'aci-4' }, items: [{ sender: 'aci-4', timestamp: 5 }] }],
        chats: [{ chat: { key: 'g:R1' }, mostRecent: [{ sender: '+1', timestamp: 8 }], mostRecentNonExpiring: [], isFullDelete: true }],
      },
    ]);
  });

  it('parses message request responses from other devices', () => {
    const parse = (mrr: any) => parseFrame({ envelope: { sourceNumber: '+1', syncMessage: { messageRequestResponse: mrr } } }, '+1', nameOf);
    assert.deepEqual(parse({ threadUuid: 'aci-4', type: 'accept' }), [{ type: 'requestResponse', chat: { key: 'aci-4' }, response: 'accept' }]);
    assert.deepEqual(parse({ groupId: 'R1', type: 'blockAndSpam' }), [{ type: 'requestResponse', chat: { key: 'g:R1' }, response: 'blockAndSpam' }]);
    assert.deepEqual(parse({ threadUuid: 'aci-4', type: 'unknown' }), []);
    assert.deepEqual(parse({ type: 'accept' }), []);
  });

  it('turns notices into notice events and drops unknown kinds', () => {
    const [ev] = parseFrame({ envelope: { sourceNumber: '+3', timestamp: 8, notice: { kind: 'missedCall', video: true, timestamp: 9 } } }, '+1', nameOf);
    assert.deepEqual(ev, { type: 'notice', convId: '+3', groupInternalId: null, author: '+3', timestamp: 9, notice: { kind: 'missedCall', video: true } });
    assert.deepEqual(parseFrame({ envelope: { sourceNumber: '+3', notice: { kind: 'somethingNew' } } }, '+1', nameOf), []);
  });

  it('adds a safety number notice before the message it came with', () => {
    const evs = parseFrame({ envelope: { sourceNumber: '+3', timestamp: 50, safetyNumberChanged: true, dataMessage: { timestamp: 50, message: 'new phone' } } }, '+1', nameOf);
    assert.deepEqual(
      evs.map((e) => e.type),
      ['notice', 'message']
    );
    assert.deepEqual(evs[0], { type: 'notice', convId: '+3', groupInternalId: null, author: '+3', timestamp: 49, notice: { kind: 'safetyNumber' } });
  });

  it('shows group call updates as a notice in the group', () => {
    const [ev] = parseFrame({ envelope: { sourceUuid: 'aci-bob', timestamp: 60, dataMessage: { timestamp: 60, groupCallUpdate: true, groupInfo: { groupId: 'GID' } } } }, '+1', nameOf);
    assert.deepEqual(ev, { type: 'notice', convId: 'g:GID', groupInternalId: 'GID', author: 'aci-bob', timestamp: 60, notice: { kind: 'groupCall' } });
  });

  it('keeps the type of quoted attachments', () => {
    const [ev] = parseFrame({ envelope: { sourceNumber: '+3', dataMessage: { message: 'nice', quote: { id: 4, authorUuid: 'aci-bob', text: '', attachments: [{ contentType: 'image/jpeg', filename: 'a.jpg' }, 'junk'] } } } }, '+1', nameOf);
    assert.equal(ev.type, 'message');
    if (ev.type === 'message') assert.deepEqual(ev.quote, { author: 'aci-bob', timestamp: 4, text: '', attachments: [{ contentType: 'image/jpeg', filename: 'a.jpg' }] });
  });

  it('drops malformed frames without throwing', () => {
    assert.deepEqual(parseFrame(null, '+1', nameOf), []);
    assert.deepEqual(parseFrame({ envelope: 'nope' }, '+1', nameOf), []);
    assert.deepEqual(parseFrame({ envelope: { dataMessage: { message: 'no sender' } } }, '+1', nameOf), []);
    assert.deepEqual(parseFrame({ envelope: { sourceNumber: '+3', dataMessage: {} } }, '+1', nameOf), []);
    assert.deepEqual(parseFrame({ envelope: { sourceNumber: '+3', somethingNew: {} } }, '+1', nameOf), []);
  });

  it('splices mentions and keeps style ranges aligned', () => {
    assert.equal(applyMentions('hi \uFFFC!', [{ start: 3, length: 1, uuid: 'aci-bob' }], nameOf), 'hi @Bob!');
    const [ev] = parseFrame({ envelope: { sourceNumber: '+3', dataMessage: { message: '\uFFFC bold', mentions: [{ start: 0, length: 1, uuid: 'aci-bob' }], textStyles: ['2:4:BOLD'] } } }, '+1', nameOf);
    assert.equal(ev.type, 'message');
    if (ev.type === 'message') {
      assert.equal(ev.body, '@Bob bold');
      assert.deepEqual(ev.styles, [{ start: 5, length: 4, style: 'BOLD' }]);
      assert.equal(ev.body.substr(ev.styles[0].start, ev.styles[0].length), 'bold');
    }
  });
});

describe('styled text', () => {
  it('parses typed markers into body ranges', () => {
    assert.deepEqual(parseStyledMarkdown('a **b** *c* ~d~ `e` ||f||'), {
      body: 'a b c d e f',
      styles: [
        { start: 2, length: 1, style: 'BOLD' },
        { start: 4, length: 1, style: 'ITALIC' },
        { start: 6, length: 1, style: 'STRIKETHROUGH' },
        { start: 8, length: 1, style: 'MONOSPACE' },
        { start: 10, length: 1, style: 'SPOILER' },
      ],
    });
  });

  it('leaves unmatched and escaped markers as text', () => {
    assert.deepEqual(parseStyledMarkdown('2 * 3'), { body: '2 * 3', styles: [] });
    assert.deepEqual(parseStyledMarkdown('\\*not\\*'), { body: '*not*', styles: [] });
  });

  it('encodes picked mentions as placeholders and moves styles to match', () => {
    const picked = [
      { name: 'Ann', uuid: 'aci-ann' },
      { name: 'Ann Lee', uuid: 'aci-lee' },
      { name: 'Gone', uuid: 'aci-gone' },
    ];
    const res = encodeMentions('hi @Ann Lee and @Ann ok', [{ start: 16, length: 7, style: 'BOLD' }], picked);
    assert.equal(res.body, 'hi \uFFFC and \uFFFC ok');
    assert.deepEqual(res.mentions, [
      { start: 3, length: 1, uuid: 'aci-lee' },
      { start: 9, length: 1, uuid: 'aci-ann' },
    ]);
    assert.deepEqual(res.styles, [{ start: 9, length: 4, style: 'BOLD' }]);
    assert.deepEqual(encodeMentions('no one here', [], picked), { body: 'no one here', styles: [], mentions: [] });
  });

  it('splits overlapping ranges into segments', () => {
    assert.deepEqual(
      styleSegments('abcd', [
        { start: 0, length: 3, style: 'BOLD' },
        { start: 2, length: 2, style: 'italic' },
      ]),
      [
        { text: 'ab', styles: ['BOLD'] },
        { text: 'c', styles: ['BOLD', 'ITALIC'] },
        { text: 'd', styles: ['ITALIC'] },
      ]
    );
    assert.deepEqual(styleSegments('x', [{ start: 0, length: 1, style: 'UNDERLINE' }]), [{ text: 'x', styles: [] }]);
  });

  it('finds emoji, jumbo emoji, and links', () => {
    assert.deepEqual(emojiRuns('hi 👋🏽!'), [
      { text: 'hi ', emoji: false },
      { text: '👋🏽', emoji: true },
      { text: '!', emoji: false },
    ]);
    assert.equal(isJumboEmoji('❤️👍'), true);
    assert.equal(isJumboEmoji('ok 👍'), false);
    assert.deepEqual(linkRuns('see https://signal.org.'), [{ text: 'see ' }, { text: 'https://signal.org', url: 'https://signal.org' }, { text: '.' }]);
  });

  it('adds a skin tone after the first code point, without VS16, and skips ZWJ sequences', () => {
    assert.equal(withSkinTone('👋', SKIN_TONES[3]), '👋\u{1F3FD}');
    assert.equal(withSkinTone('☝\uFE0F', SKIN_TONES[1]), '☝\u{1F3FB}');
    assert.equal(withSkinTone('👨‍🦰', SKIN_TONES[5]), '👨‍🦰');
    assert.equal(withSkinTone('👋', SKIN_TONES[0]), '👋');
    assert.equal(SKIN_TONES.length, 6);
    assert.deepEqual(emojiRuns(withSkinTone('✌\uFE0F', SKIN_TONES[4])), [{ text: '✌\u{1F3FE}', emoji: true }]);
  });
});

describe('format', () => {
  it('formats durations, timers, initials, and safety numbers', () => {
    assert.equal(fmtDuration(45), '45s');
    assert.equal(fmtDuration(3600), '1h');
    assert.equal(expireLabel(604800), '1 week');
    assert.equal(expireLabel(0), 'Off');
    assert.equal(initials('ada lovelace'), 'AL');
    assert.equal(initials(''), '?');
    assert.deepEqual(formatSafetyNumber('123456789012345'), ['12345', '67890', '12345']);
  });
});

describe('store helpers', () => {
  it('picks the best contact name', () => {
    assert.equal(contactName({ uuid: 'u', number: '+1', name: 'Ann' }), 'Ann');
    assert.equal(contactName({ uuid: 'u', number: '+1', name: '', nickname: { given_name: 'Al', family_name: 'B' } }), 'Al B');
    assert.equal(contactName({ uuid: 'u', number: '+1', name: 'Note to Self', username: 'al.01' }), 'al.01');
    assert.equal(contactName({ uuid: 'u', number: '', name: '' }), 'u');
  });

  it('labels attachment-only messages', () => {
    assert.equal(attachmentLabel([{ id: '', contentType: 'image/jpeg', filename: '', size: 0 }]), 'Photo');
    assert.equal(attachmentLabel([{ id: '', contentType: 'audio/aac', filename: '', size: 0, voiceNote: true }]), 'Voice message');
    assert.equal(attachmentLabel([{ id: '', contentType: 'application/pdf', filename: 'a.pdf', size: 0 }]), 'a.pdf');
  });
});

describe('debug log', () => {
  it('redacts numbers, account IDs, and tokens when shared', () => {
    dbg('from +15551234567 aci 12345678-1234-1234-1234-123456789abc key ' + 'A'.repeat(40));
    const out = redactedLog();
    assert.ok(!out.includes('+15551234567'));
    assert.ok(!out.includes('123456789abc'));
    assert.ok(!out.includes('A'.repeat(40)));
    assert.ok(out.includes('+…67'));
  });
});
