import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { expireLabel, fmtDuration, formatSafetyNumber, initials } from '../src/ui/data/format';
import { dbg, redactedLog } from '../src/ui/data/log';
import { fetchLinkPreview, previewCandidate } from '../src/ui/data/link-preview-fetch';
import { previewFieldsForSend } from '../src/engine/services/link-previews';
import { applyMentions, parseFrame } from '../src/ui/data/normalize';
import { attachmentLabel, contactName } from '../src/ui/data/store';
import { emojiRuns, encodeMentions, isJumboEmoji, linkRuns, parseStyledMarkdown, SKIN_TONES, styleSegments, withSkinTone } from '../src/ui/data/styled';

const nameOf = (k: string) => (k === 'aci-bob' ? 'Bob' : k);

describe('link previews we send', () => {
  type Page = { status?: number; url?: string; headers?: Record<string, string>; text?: string; bytes?: Uint8Array };
  function deps(pages: Record<string, Page>, docs: Record<string, { title?: string; meta?: Record<string, string>; link?: Record<string, string> }>) {
    const fetched: string[] = [];
    const scaled: string[] = [];
    return {
      fetched,
      scaled,
      deps: {
        fetch: async (url: string, as: 'text' | 'bytes', maxBytes: number) => {
          fetched.push(as + ' ' + url);
          const p = pages[url];
          if (!p) throw new Error('network');
          if (as === 'bytes' && p.bytes && p.bytes.length > maxBytes) throw new Error('too large');
          const headers = p.headers || {};
          return { status: p.status || 200, url: p.url || url, header: (n: string) => headers[n] ?? null, text: p.text, bytes: p.bytes };
        },
        parse: (html: string) => {
          const d = docs[html] || {};
          return { title: d.title || '', meta: (a: string, k: string) => (d.meta || {})[a + ':' + k] ?? null, link: (rel: string) => (d.link || {})[rel] ?? null };
        },
        scale: async (img: { data: Uint8Array; contentType: string }) => {
          scaled.push(img.contentType);
          return { data: img.data.slice(0, 2), contentType: 'image/jpeg' };
        },
      },
    };
  }
  const html = { 'Content-Type': 'text/html; charset=utf-8' };
  const png = new Uint8Array(20).fill(9);

  it('reads Open Graph tags, resolves and scales the image, and keeps sane dates', async () => {
    const t = deps(
      {
        'https://news.site/a': { url: 'https://news.site/a?x=1', headers: html, text: 'A' },
        'https://news.site/img/a.png': { headers: { 'Content-Type': 'image/png' }, bytes: png },
      },
      { A: { title: 'Page title', meta: { 'property:og:title': ' Story ', 'property:og:description': 'About it', 'property:og:image': '/img/a.png#top', 'property:article:published_time': '2026-01-02T00:00:00Z' } } }
    );
    const p = await fetchLinkPreview('https://news.site/a', t.deps);
    assert.deepEqual(p, { url: 'https://news.site/a', title: 'Story', description: 'About it', date: Date.parse('2026-01-02T00:00:00Z'), image: { data: png.slice(0, 2), contentType: 'image/jpeg' } });
    assert.deepEqual(t.fetched, ['text https://news.site/a', 'bytes https://news.site/img/a.png']);
    assert.deepEqual(t.scaled, ['image/png']);
  });

  it('falls back to the page title and icons, and drops bad dates, big images, and pages without a title', async () => {
    const t = deps(
      {
        'https://a.site/': { headers: html, text: 'B' },
        'https://a.site/icon.png': { headers: { 'Content-Type': 'image/png' }, bytes: new Uint8Array(2 * 1024 * 1024) },
        'https://b.site/': { headers: html, text: 'C' },
      },
      { B: { title: 'Plain', meta: { 'name:description': 'Desc', 'property:og:published_time': '3100-01-01' }, link: { icon: '/icon.png' } }, C: {} }
    );
    assert.deepEqual(await fetchLinkPreview('https://a.site/', t.deps), { url: 'https://a.site/', title: 'Plain', description: 'Desc' });
    assert.equal(await fetchLinkPreview('https://b.site/', t.deps), null);
  });

  it('refuses unsafe links, redirects, downloads, and non-HTML pages', async () => {
    const t = deps(
      {
        'https://r.site/': { url: 'http://r.site/', headers: html, text: 'A' },
        'https://d.site/': { headers: { ...html, 'Content-Disposition': 'attachment; filename=x' }, text: 'A' },
        'https://j.site/': { headers: { 'Content-Type': 'application/json' }, text: '{}' },
        'https://e.site/': { status: 404, headers: html, text: 'A' },
      },
      { A: { title: 'T' } }
    );
    for (const u of ['http://plain.site/', 'https://localhost/', 'https://xn--80ak6aa92e.com/', 'https://r.site/', 'https://d.site/', 'https://j.site/', 'https://e.site/']) {
      assert.equal(await fetchLinkPreview(u, t.deps), null, u);
    }
    assert.ok(!t.fetched.some((f) => f.indexOf('plain.site') >= 0 || f.indexOf('localhost') >= 0));
  });

  it('only looks for a link to preview when the setting is on and the draft is plain text', () => {
    const draft = 'see http://insecure.site and https://signal.org/blog, ok';
    assert.equal(previewCandidate(draft, { enabled: true, plainText: true }), 'https://signal.org/blog');
    assert.equal(previewCandidate(draft, { enabled: false, plainText: true }), '');
    assert.equal(previewCandidate(draft, { enabled: true, plainText: false }), '');
    assert.equal(previewCandidate('no links', { enabled: true, plainText: true }), '');
  });

  it('checks what goes into the preview we send', () => {
    const body = 'look https://signal.org/blog';
    const p = { url: 'https://signal.org/blog', title: '  T  ', description: 'x'.repeat(400), date: 1700000000000.5 };
    assert.deepEqual(previewFieldsForSend(p, body, false), { url: 'https://signal.org/blog', title: 'T', description: 'x'.repeat(300), date: 1700000000000n });
    assert.equal(previewFieldsForSend(p, body, true), null, 'not with attachments');
    assert.equal(previewFieldsForSend(p, 'no link', false), null);
    assert.equal(previewFieldsForSend({ ...p, title: ' ' }, body, false), null);
    assert.equal(previewFieldsForSend(undefined, body, false), null);
  });
});

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

  it('shows 1:1 story replies with a story quote and reactions as a notice, and drops group story replies', () => {
    const story = { authorUuid: 'aci-me', sentTimestamp: 70 };
    const parse = (dm: any) => parseFrame({ envelope: { sourceNumber: '+3', timestamp: 80, dataMessage: { timestamp: 80, storyContext: story, ...dm } } }, '+1', nameOf);
    const [reply] = parse({ message: 'love it' });
    assert.equal(reply.type, 'message');
    if (reply.type === 'message') {
      assert.equal(reply.body, 'love it');
      assert.deepEqual(reply.quote, { author: 'aci-me', timestamp: 70, text: '', story: true });
    }
    assert.deepEqual(parse({ reaction: { emoji: '❤️', targetSentTimestamp: 70 } }), [
      { type: 'notice', convId: '+3', groupInternalId: null, author: '+3', timestamp: 80, notice: { kind: 'storyReaction', text: '❤️' } },
    ]);
    assert.deepEqual(parse({ reaction: { emoji: '❤️', isRemove: true } }), []);
    assert.deepEqual(parse({ reaction: { emoji: '' } }), []);
    assert.deepEqual(parse({ message: 'nice', groupInfo: { groupId: 'GID' } }), []);
  });

  it('shows payments as a notice and drops unknown payment kinds', () => {
    const parse = (payment: any) => parseFrame({ envelope: { sourceNumber: '+3', timestamp: 90, dataMessage: { timestamp: 90, payment } } }, '+1', nameOf);
    for (const kind of ['notification', 'activationRequest', 'activated']) {
      assert.deepEqual(parse({ kind }), [{ type: 'notice', convId: '+3', groupInternalId: null, author: '+3', timestamp: 90, notice: { kind: 'payment', value: kind } }]);
    }
    assert.deepEqual(parse({ kind: 'refund' }), []);
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
