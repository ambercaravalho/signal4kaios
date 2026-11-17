import './ui-env';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'preact-render-to-string';

import { _stackForTest, router, RouterView } from '../src/ui/app/router';
import { Avatar, AVATAR_COLORS, avatarColorIndex } from '../src/ui/components/Avatar';
import { Badge, ListItem } from '../src/ui/components/List';
import { confirm, dialogKey, DIVIDER, menuRows, pick, showOptions } from '../src/ui/components/Overlays';
import { QrCode } from '../src/ui/components/Qr';
import { RichText } from '../src/ui/components/RichText';
import { focusIndex } from '../src/ui/components/RowList';
import { AUTOMATIC, CHAT_COLORS, chatColorOptions } from '../src/ui/data/chat-colors';
import { signal } from '../src/ui/data/api';
import { config } from '../src/ui/data/config';
import { db } from '../src/ui/data/db';
import { GUIDES } from '../src/ui/data/guides';
import { callingCode, toE164 } from '../src/ui/data/phone-number';
import * as store from '../src/ui/data/store';
import type { Message } from '../src/ui/data/types';
import { askViewOnce } from '../src/ui/components/chat/useChatComposer';
import { backAction } from '../src/ui/components/chat/useChatKeys';
import { asksBeforeDiscard } from '../src/ui/components/VoiceRecorder';
import { Bubble, canForward, ChatScreen, mainActions, PinnedBar } from '../src/ui/screens/Chat';
import { ChatSettingsScreen } from '../src/ui/screens/ChatSettings';
import { DebugScreen } from '../src/ui/screens/Debug';
import { guideRow, openGuide } from '../src/ui/screens/Guide';
import { ArchivedScreen, HomeScreen } from '../src/ui/screens/Home';
import { memberAvatar } from '../src/ui/screens/Members';
import { LinkScreen, WelcomeScreen } from '../src/ui/screens/Onboarding';
import { openPhone } from '../src/ui/screens/open-link';
import { NewChatScreen, SearchScreen } from '../src/ui/screens/SearchList';
import { SettingsScreen } from '../src/ui/screens/Settings';
import { AppearanceScreen } from '../src/ui/screens/settings/Appearance';
import { HELP_TOPICS, HelpScreen } from '../src/ui/screens/settings/Help';
import { NotificationsScreen } from '../src/ui/screens/settings/Notifications';
import { saveProfile } from '../src/ui/screens/settings/Profile';
import { skipHistory } from '../src/ui/screens/History';
import { StartupErrorScreen, storageErrorOptions } from '../src/ui/screens/StartupError';
import { DEBUG, fmt, S } from '../src/ui/strings';
import { settle } from './helpers';

const ME = '+15550000';
const ALICE = '+15550001';
const JARGON = /\b(pre-?keys?|aci|pni|uuid|websocket|libsignal|wasm|provisioning|e2ee|protobuf)\b/i;

function html(): string {
  return renderToString(<RouterView />);
}

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&#39;|&rsquo;/g, '’');
}

describe('components', () => {
  it('highlights the focused row and shows its parts', () => {
    router.reset(() => <ListItem focused primary="Alice" secondary="hi" meta="12:00" />, {});
    const out = html();
    assert.match(out, /class="li focused"/);
    assert.match(out, /Alice/);
    assert.match(out, /12:00/);
    assert.equal(renderToString(<Badge count={0} />), '');
    assert.match(renderToString(<Badge count={120} />), /99\+/);
  });

  it('draws initials on the Signal avatar color', () => {
    const idx = avatarColorIndex({ e164: ALICE });
    assert.ok(idx >= 0 && idx < AVATAR_COLORS.length);
    assert.equal(avatarColorIndex({ e164: ALICE }), idx);
    const out = renderToString(<Avatar conv={{ id: ALICE, type: 'direct', name: 'Alice Smith' }} />);
    assert.match(out, />AS</);
    assert.match(out, new RegExp(AVATAR_COLORS[idx][0].replace('#', '#?'), 'i'));
  });

  it('renders formatting, spoilers, and links', () => {
    const out = renderToString(
      <RichText
        text="bold secret https://signal.org"
        styles={[
          { start: 0, length: 4, style: 'BOLD' },
          { start: 5, length: 6, style: 'SPOILER' },
        ]}
      />
    );
    assert.match(out, /class="fmt-b"/);
    assert.match(out, /class="fmt-spoiler"/);
    assert.match(out, /class="link"/);
  });

  it('drops dividers at the edges and next to each other', () => {
    const a = { label: 'A', onSelect() {} };
    const b = { label: 'B', onSelect() {} };
    assert.deepEqual(menuRows([DIVIDER, a, null, DIVIDER, false, DIVIDER, b, DIVIDER]), [a, DIVIDER, b]);
    assert.deepEqual(menuRows([DIVIDER, null, DIVIDER]), []);
  });

  it('draws a QR code as one SVG path', () => {
    const out = renderToString(<QrCode text="sgnl://linkdevice?uuid=x" />);
    assert.match(out, /<svg/);
    assert.match(out, /<path/);
  });
});

describe('screens', () => {
  before(async () => {
    config.set({ number: ME, aci: '00000000-0000-4000-8000-000000000000', deviceId: 2, deviceToken: 'test-only' });
    await db.ready();
    await db.kvSet('syncedContacts', [{ uuid: '', number: ALICE, name: 'Alice' }]);
    await store.refreshDirectory();
  });

  it('shows the first-run welcome and the linking screen', () => {
    router.reset(WelcomeScreen, {});
    assert.match(html(), /Welcome to Beacon/);
    router.reset(LinkScreen, { mode: 'relink' as const });
    const out = html();
    assert.match(out, new RegExp(S.linkTitle));
    assert.match(text(out), /unlinked/);
  });

  it('lists chats with previews and unread counts', async () => {
    router.reset(HomeScreen, {});
    assert.doesNotMatch(html(), /class="tabs?"/);
    store.ingestRaw({ envelope: { sourceNumber: ALICE, sourceName: 'Alice', timestamp: 1000, dataMessage: { timestamp: 1000, message: 'hello there' } } });
    await settle();
    const out = html();
    assert.match(out, /Alice/);
    assert.match(out, /hello there/);
    assert.match(out, /class="badge">1</);
    assert.doesNotMatch(out, new RegExp(S.archivedChats));
  });

  it('keeps archived chats behind a row at the bottom of the list', async () => {
    store.setArchived(ALICE, true);
    await settle();
    router.reset(HomeScreen, {});
    let out = html();
    assert.match(out, new RegExp(S.archivedChats));
    assert.doesNotMatch(out, /hello there/);
    router.push(ArchivedScreen, {});
    out = html();
    assert.match(out, /hello there/);
    store.setArchived(ALICE, false);
    await settle();
    router.reset(HomeScreen, {});
    assert.doesNotMatch(html(), new RegExp(S.archivedChats));
  });

  it('puts the time at the end of the text, or over a photo-only message', () => {
    const base: Message = { id: 'm1', convId: ALICE, author: ALICE, timestamp: 1000, body: 'short', incoming: true, status: 'received', attachments: [], reactions: {} } as unknown as Message;
    router.reset(() => <Bubble m={base} focused={false} showAuthor={false} onClipped={() => {}} />, {});
    assert.match(html(), /class="msg-body"><[^]*class="msg-meta"[^]*<\/div>/);
    assert.doesNotMatch(html(), /msg-meta-line/);
    const file = { ...base, body: '', attachments: [{ id: 'a1', contentType: 'application/pdf', size: 10 }] } as unknown as Message;
    router.reset(() => <Bubble m={file} focused={false} showAuthor={false} onClipped={() => {}} />, {});
    assert.match(html(), /class="msg-file"[^]*class="msg-meta"/);
  });

  it('leads message options with what the message is for', () => {
    const base = { id: 'm2', convId: ALICE, author: ALICE, timestamp: 1000, body: '', incoming: true, status: 'received', attachments: [], reactions: {} } as unknown as Message;
    const photo = { ...base, attachments: [{ id: 'a1', contentType: 'image/jpeg', size: 10 }] } as Message;
    assert.deepEqual(mainActions(photo, false), ['attachment']);
    const album = { ...base, attachments: [photo.attachments[0], { id: 'a2', contentType: 'image/jpeg', size: 12 }] } as Message;
    assert.ok(canForward(album));
    assert.ok(!canForward({ ...album, attachments: [album.attachments[0], { ...album.attachments[1], id: '' }] } as Message));
    assert.deepEqual(mainActions({ ...base, body: 'see https://signal.org', status: 'failed', incoming: false } as Message, true), ['retry', 'readFull', 'openLink']);
    assert.deepEqual(mainActions({ ...photo, deleted: true } as Message, false), []);
    assert.deepEqual(mainActions({ ...base, body: 'hi' } as Message, false), []);
    const poll = { ...base, poll: { question: 'Lunch?', options: ['Pizza', 'Soup'], allowMultiple: false, votes: { [ME]: { options: [1], voteCount: 1, timestamp: 1 } } } } as Message;
    assert.deepEqual(mainActions(poll, false), ['vote']);
    assert.deepEqual(mainActions({ ...poll, poll: { ...poll.poll!, ended: true } } as Message, false), []);
    router.reset(() => <Bubble m={poll} focused={false} showAuthor={false} onClipped={() => {}} />, {});
    const out = html();
    assert.match(out, /class="poll-question">Lunch\?/);
    assert.match(out, /class="poll-mark on"[^]*Soup/);
    assert.match(out, /Choose one/);
  });

  it('shows a link preview’s title and domain under the text', () => {
    const m = { id: 'm3', convId: ALICE, author: ALICE, timestamp: 1000, incoming: true, status: 'received', attachments: [], reactions: {}, body: 'read https://signal.org/blog/x', preview: { url: 'https://signal.org/blog/x', title: 'Signal blog' } } as unknown as Message;
    router.reset(() => <Bubble m={m} focused={false} showAuthor={false} onClipped={() => {}} />, {});
    assert.match(html(), /class="msg-link-title">Signal blog<\/div><div class="msg-link-domain">signal\.org</);
  });

  it('names a pinned poll or photo in the pinned bar', () => {
    const base = { id: 'p1', convId: ALICE, author: ALICE, timestamp: 1000, incoming: true, status: 'received', attachments: [], reactions: {}, body: '' };
    const poll = { ...base, poll: { question: 'Lunch?', options: ['Yes', 'No'], allowMultiple: false, votes: {} } } as unknown as Message;
    router.reset(() => <PinnedBar last={poll} count={2} />, {});
    let out = text(html());
    assert.ok(out.includes(fmt(S.pollPreview, { question: 'Lunch?' })), out);
    assert.ok(out.includes('2'));
    const photo = { ...base, attachments: [{ id: 'a', contentType: 'image/jpeg', filename: 'a.jpg', size: 3 }] } as unknown as Message;
    router.reset(() => <PinnedBar last={photo} count={1} />, {});
    out = text(html());
    assert.ok(out.includes(S.photo), out);
    assert.doesNotMatch(html(), /pinned-count/);
  });

  it('asks whether a picked photo or video goes view-once, instead of a separate menu item', async () => {
    assert.equal((S as any).attachViewOnce, undefined);
    assert.equal(await askViewOnce('application/pdf'), false);
    for (const [type, title] of [['image/jpeg', S.photo], ['video/mp4', S.video]]) {
      router.reset(HomeScreen, {});
      askViewOnce(type);
      const out = text(html());
      for (const s of [title, S.attachNormal, S.sendViewOnce]) assert.ok(out.includes(s), s);
      router.pop();
    }
  });

  it('opens a chat with its title and message box', () => {
    router.reset(HomeScreen, {});
    router.push(ChatScreen, { convId: ALICE });
    const out = html();
    assert.equal(_stackForTest().length, 2);
    assert.match(out, /entry hidden/);
    assert.match(out, /placeholder="Message"/);
  });

  it('looks up a number that is not a synced contact before opening its chat', async () => {
    const BOB = '+15550002';
    const asked: string[] = [];
    let answer: (n: string) => Promise<{ uuid: string; number: string } | null> = async (n) => ({ uuid: '11111111-1111-4111-8111-111111111111', number: n });
    (signal as any).lookupNumber = (n: string) => {
      asked.push(n);
      return answer(n);
    };
    router.reset(HomeScreen, {});
    await openPhone(BOB);
    assert.deepEqual(asked, [BOB]);
    assert.equal(_stackForTest().length, 2);
    assert.equal(_stackForTest()[1].Component, ChatScreen);
    assert.ok(store.conversation(BOB));

    router.reset(HomeScreen, {});
    answer = async () => null;
    await openPhone('+15550003');
    assert.equal(_stackForTest().length, 2);
    assert.ok(_stackForTest()[1].overlay);
    assert.ok(text(html()).includes(S.phoneNotFound));
    assert.ok(text(html()).includes('+15550003'), 'says which number was looked up');

    router.reset(HomeScreen, {});
    answer = async () => {
      throw Object.assign(new Error('rate limited'), { retryAfterSeconds: 90, status: 429 });
    };
    await openPhone('+15550004');
    assert.equal(_stackForTest().length, 1);
  });

  it('keeps focus on the same chat when the list reorders, and follows the user when they move', () => {
    assert.equal(focusIndex(['b', 'a', 'c'], 1, { key: 'c', navIndex: 1 }), 2, 'a new message moved another chat to the top');
    assert.equal(focusIndex(['b', 'a', 'c'], 2, { key: 'a', navIndex: 1 }), 2, 'the user pressed Down');
    assert.equal(focusIndex(['b', 'c'], 1, { key: 'a', navIndex: 1 }), 1, 'a deleted chat leaves focus in place');
    assert.equal(focusIndex([undefined, undefined], 1, { navIndex: 1 }), 1);
  });

  it('reads a number typed without a country code as one in our own country', () => {
    assert.equal(toE164('07700 900123', '+447700900000'), '+447700900123');
    assert.equal(toE164('0044 7700 900123', '+15550000000'), '+447700900123');
    assert.equal(toE164('011 44 7700 900123', '+15550000000'), '+447700900123');
    assert.equal(toE164('(555) 010-2030', '+15550000000'), '+15550102030');
    assert.equal(toE164('1 555 010 2030', '+15550000000'), '+15550102030');
    assert.equal(toE164('06 12345678', '+33612345678'), '+33612345678');
    assert.equal(toE164('06 123 4567', '+390612345678'), '+39061234567', 'Italy keeps its leading 0');
    assert.equal(toE164('8 912 345 67 89', '+79000000000'), '+79123456789');
    assert.equal(toE164('612 345 678', '+34600000000'), '+34612345678');
    assert.equal(toE164('+49 30 123456', '+447700900000'), '+4930123456');
    assert.equal(toE164('15550102030', ''), '+15550102030', 'without our own number it reads as international');
    assert.equal(callingCode('+353861234567'), '353');
    assert.equal(callingCode('+4930123456'), '49');
  });

  it('draws options and dialogs as overlays above the screen', () => {
    router.reset(HomeScreen, {});
    showOptions([{ label: 'First', onSelect() {} }, null, { label: 'Second', onSelect() {} }]);
    let out = html();
    assert.match(out, /entry entry-overlay/);
    assert.match(out, /First/);
    assert.match(out, /Second/);
    router.pop();
    confirm({ title: 'Delete message?', body: 'Gone for good.' });
    out = html();
    assert.match(out, /Delete message\?/);
    router.pop();
    assert.equal(_stackForTest().length, 1);
  });

  it('confirms a two-button dialog only with its labelled right softkey, never with OK', () => {
    assert.equal(dialogKey('Enter', true), 'ignore');
    assert.equal(dialogKey('SoftRight', true), 'confirm');
    assert.equal(dialogKey('SoftLeft', true), 'cancel');
    assert.equal(dialogKey('Backspace', true), 'cancel');
    assert.equal(dialogKey('ArrowDown', true), null);
    assert.equal(dialogKey('Enter', false), 'confirm', 'a one-button alert still closes with OK');
    assert.equal(dialogKey('SoftLeft', false), 'confirm');
  });

  it('renders every everyday screen without technical terms', () => {
    const screens: Array<[any, any]> = [
      [HomeScreen, {}],
      [ChatScreen, { convId: ALICE }],
      [ChatSettingsScreen, { convId: ALICE }],
      [NewChatScreen, {}],
      [SearchScreen, {}],
      [SettingsScreen, {}],
      [NotificationsScreen, {}],
      [HelpScreen, {}],
      [WelcomeScreen, {}],
      [StartupErrorScreen, { reason: 'blocked', detail: 'LibsignalUnavailableError: wasm blocked' }],
    ];
    for (const [C, props] of screens) {
      router.reset(C, props);
      const out = text(html());
      assert.ok(out.trim().length > 0, C.name);
      assert.ok(!JARGON.test(out), C.name + ': ' + out);
    }
  });

  it('keeps connection details under Debug, not in the main Settings list', () => {
    router.reset(SettingsScreen, {});
    assert.ok(!text(html()).includes(DEBUG.tls));
    router.reset(DebugScreen, {});
    assert.ok(text(html()).includes(DEBUG.tls));
  });

  it('shows a guide as a pictogram and a QR code of its page', () => {
    router.reset(HomeScreen, {});
    openGuide('proxy');
    assert.equal(_stackForTest().length, 2);
    const out = html();
    assert.ok(text(out).includes(GUIDES.proxy.title));
    assert.ok(text(out).includes(S.guideScan));
    assert.match(out, /class="guide-head"><svg class="pictogram guide-pictogram"/);
    assert.match(out, /class="qr"[^]*<svg/);
    const row = guideRow('settings');
    assert.equal(row.label, S.learnMore);
    assert.equal(row.end, 'chevron');
  });

  it('lists every help topic, then the source and version', () => {
    router.reset(HelpScreen, {});
    const out = text(html());
    for (const topic of HELP_TOPICS) assert.ok(out.includes(GUIDES[topic].title), topic);
    assert.ok(out.includes(S.sourceCode));
    assert.ok(out.includes(S.unofficial));
  });

  it('draws a pictogram on empty lists', () => {
    for (const [C, name] of [[SearchScreen, 'search'], [ArchivedScreen, 'archive'], [WelcomeScreen, 'welcome']] as const) {
      router.reset(C as any, {});
      assert.match(html(), /<svg class="pictogram"/, name);
    }
  });

  it('shows chat settings for a person', () => {
    router.reset(ChatSettingsScreen, { convId: ALICE });
    const out = html();
    assert.match(out, new RegExp(S.disappearingMessages));
    assert.match(out, new RegExp(S.viewSafetyNumber));
    assert.match(out, new RegExp('>' + S.block + '<'));
    assert.ok(!out.includes(S.notifyForCalls), 'call exceptions only show while muted');
  });

  it('shows how long a chat is muted and what still gets through', () => {
    store.setMuted(ALICE, Date.now() + 3600000);
    router.reset(ChatSettingsScreen, { convId: ALICE });
    const out = text(html());
    assert.ok(out.includes(S.mutedUntil.replace('{time}', '')));
    assert.ok(out.includes(S.notifyForCalls));
    assert.ok(!out.includes(S.notifyForMentions), 'mentions are for groups');
    store.setMuted(ALICE, 0);
  });

  it('lists notification settings, with profiles from the phone', () => {
    router.reset(NotificationsScreen, {});
    let out = text(html());
    for (const s of [S.notifyShow, S.showNameAndMessage, S.reactionNotifications, S.inMutedChats, S.notifyForReplies, S.noProfiles]) assert.ok(out.includes(s), s);
    config.set({ notificationProfiles: [{ id: 'eA==', name: 'Sleep', emoji: '🌙', createdAt: 1, allowAllCalls: false, allowAllMentions: false, allowed: [], schedule: null }], notificationProfileOverride: { enabledId: 'eA==', endAt: 0 } });
    router.reset(NotificationsScreen, {});
    out = text(html());
    assert.ok(out.includes('🌙 Sleep'));
    config.set({ notificationProfiles: undefined, notificationProfileOverride: undefined });
  });

  it('colors a chat’s bubbles with its own color, else the default', () => {
    const bodyClass = () => (html().match(/class="body (chat-body[^"]*)"/) || [])[1];
    const shows = (screen: any, props: any, line: string) => {
      router.reset(screen, props);
      assert.ok(text(html()).replace(/\s+/g, ' ').includes(S.chatColor + ' ' + line), line);
    };
    router.reset(ChatScreen, { convId: ALICE });
    assert.equal(bodyClass(), 'chat-body');
    config.set({ chatColor: 'plum' });
    router.reset(ChatScreen, { convId: ALICE });
    assert.equal(bodyClass(), 'chat-body chat-color-plum');
    shows(ChatSettingsScreen, { convId: ALICE }, fmt(S.chatColorDefault, { name: 'Plum' }));
    store.setChatColor(ALICE, 'forest');
    router.reset(ChatScreen, { convId: ALICE });
    assert.equal(bodyClass(), 'chat-body chat-color-forest');
    shows(ChatSettingsScreen, { convId: ALICE }, 'Forest');
    shows(AppearanceScreen, {}, 'Plum');
    store.setChatColor(ALICE, null);
    config.set({ chatColor: undefined });
    shows(AppearanceScreen, {}, S.chatColorAutomatic);
  });

  it('shows a swatch beside each chat color in the picker', () => {
    router.reset(AppearanceScreen, {});
    pick(S.chatColor, chatColorOptions({ value: AUTOMATIC, label: S.chatColorAutomatic, swatch: AUTOMATIC }), AUTOMATIC);
    const out = html();
    assert.match(out, /<span class="swatch"><\/span>[^]*Automatic/);
    for (const c of CHAT_COLORS) assert.match(out, new RegExp('<span class="swatch chat-color-' + c + '">'), c);
    router.pop();
  });

  it('shows our profile photo or initials for "You" in a member list, not the Note to Self icon', () => {
    const NOTE = 'M6 3h12v18H6z';
    assert.ok(renderToString(<Avatar conv={{ id: ME, type: 'direct', name: 'Note to Self' }} />).includes(NOTE));
    config.set({ profileName: 'Mia Park' });
    const out = renderToString(memberAvatar(config.aci()));
    assert.ok(!out.includes(NOTE));
    assert.match(out, />MP</);
    config.set({ profileName: undefined });
  });

  it('saves a new name without resending an About this phone may have out of date', async () => {
    const bodies: any[] = [];
    const real = signal.updateOwnProfile;
    (signal as any).updateOwnProfile = async (body: any) => void bodies.push(body);
    config.set({ profileName: 'Mia Park', profileAbout: 'old about' });
    try {
      await saveProfile({ name: 'Mia P' });
      await saveProfile({ about: 'new about' });
    } finally {
      (signal as any).updateOwnProfile = real;
      config.set({ profileName: undefined, profileAbout: undefined });
    }
    assert.deepEqual(bodies, [{ name: 'Mia P' }, { name: 'Mia P', about: 'new about' }]);
  });

  it('keeps the old name when the profile upload fails', async () => {
    const real = signal.updateOwnProfile;
    (signal as any).updateOwnProfile = async () => {
      throw new Error('The profile was not written');
    };
    config.set({ profileName: 'Mia Park' });
    try {
      await saveProfile({ name: 'Mia P' });
      assert.equal(config.profileName(), 'Mia Park');
    } finally {
      (signal as any).updateOwnProfile = real;
      config.set({ profileName: undefined });
    }
  });

  it('asks before Back throws away attachments in the tray or a voice recording', () => {
    const at = { onComposer: true, draft: '', quote: false, editing: false, tray: 0 };
    assert.equal(backAction('Backspace', at), 'pass');
    assert.equal(backAction('SoftLeft', at), 'pass');
    assert.equal(backAction('Backspace', { ...at, tray: 2 }), 'askLeave');
    assert.equal(backAction('SoftLeft', { ...at, tray: 1 }), 'askLeave');
    assert.equal(backAction('Backspace', { ...at, tray: 1, draft: 'hi' }), 'pass', 'Back deletes a typed character first');
    assert.equal(backAction('SoftLeft', { ...at, tray: 1, quote: true }), 'clear');
    assert.equal(backAction('Backspace', { ...at, onComposer: false, tray: 1 }), 'unfocus');
    assert.equal(backAction('SoftLeft', { ...at, onComposer: false }), 'unfocus', 'Back on a message returns to the composer, not out of the chat');
    assert.equal(backAction('SoftLeft', { ...at, onComposer: false, quote: true }), 'clear');
    assert.ok(asksBeforeDiscard('recording'));
    assert.ok(asksBeforeDiscard('stopped'));
    assert.ok(!asksBeforeDiscard('starting'));
    assert.ok(!asksBeforeDiscard('failed'));
  });

  it('asks before skipping message history, and offers Delete all data when storage won’t open', () => {
    router.reset(HomeScreen, {});
    skipHistory();
    const top = _stackForTest()[_stackForTest().length - 1];
    assert.ok(top.overlay);
    assert.match(html(), new RegExp(S.skipHistory.replace('?', '\\?')));
    router.pop();
    const labels = storageErrorOptions().map((o) => (o && typeof o === 'object' ? o.label : o));
    assert.deepEqual(labels, [S.help, '-', S.deleteAllData]);
  });
});
