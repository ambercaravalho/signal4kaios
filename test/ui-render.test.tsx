import './ui-env';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'preact-render-to-string';

import { _stackForTest, router, RouterView } from '../src/ui/app/router';
import { Avatar, AVATAR_COLORS, avatarColorIndex } from '../src/ui/components/Avatar';
import { Badge, ListItem } from '../src/ui/components/List';
import { confirm, DIVIDER, menuRows, showOptions } from '../src/ui/components/Overlays';
import { QrCode } from '../src/ui/components/Qr';
import { RichText } from '../src/ui/components/RichText';
import { config } from '../src/ui/data/config';
import { db } from '../src/ui/data/db';
import * as store from '../src/ui/data/store';
import type { Message } from '../src/ui/data/types';
import { Bubble, ChatScreen } from '../src/ui/screens/Chat';
import { ChatSettingsScreen } from '../src/ui/screens/ChatSettings';
import { DebugScreen, FasterConnectionScreen } from '../src/ui/screens/Debug';
import { ArchivedScreen, HomeScreen } from '../src/ui/screens/Home';
import { LinkScreen, WelcomeScreen } from '../src/ui/screens/Onboarding';
import { NewChatScreen, SearchScreen } from '../src/ui/screens/SearchList';
import { SettingsScreen } from '../src/ui/screens/Settings';
import { StartupErrorScreen } from '../src/ui/screens/StartupError';
import { DEBUG, S } from '../src/ui/strings';

const ME = '+15550000';
const ALICE = '+15550001';
const JARGON = /\b(pre-?keys?|aci|pni|uuid|websocket|libsignal|wasm|provisioning|e2ee|protobuf)\b/i;

function settle(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

  it('opens a chat with its title and message box', () => {
    router.reset(HomeScreen, {});
    router.push(ChatScreen, { convId: ALICE });
    const out = html();
    assert.equal(_stackForTest().length, 2);
    assert.match(out, /entry hidden/);
    assert.match(out, /placeholder="Message"/);
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

  it('renders every everyday screen without technical terms', () => {
    const screens: Array<[any, any]> = [
      [HomeScreen, {}],
      [ChatScreen, { convId: ALICE }],
      [ChatSettingsScreen, { convId: ALICE }],
      [NewChatScreen, {}],
      [SearchScreen, {}],
      [SettingsScreen, {}],
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

  it('keeps Faster connection under Debug, not in the main Settings list', () => {
    router.reset(SettingsScreen, {});
    assert.ok(!text(html()).includes(DEBUG.fasterConnection));
    router.reset(DebugScreen, {});
    const debug = text(html());
    assert.ok(debug.includes(DEBUG.fasterConnection));
    assert.ok(debug.includes(DEBUG.fasterChecking));
  });

  it('explains Faster connection and how to turn it on', () => {
    router.reset(FasterConnectionScreen, {});
    const out = text(html());
    for (const s of [DEBUG.fasterUsedForValue, DEBUG.fasterNeedsValue, DEBUG.fasterOtherValue, DEBUG.fasterHowTo, DEBUG.fasterCheckAgain]) assert.ok(out.includes(s), s);
  });

  it('shows chat settings for a person', () => {
    router.reset(ChatSettingsScreen, { convId: ALICE });
    const out = html();
    assert.match(out, new RegExp(S.disappearingMessages));
    assert.match(out, new RegExp(S.viewSafetyNumber));
    assert.match(out, new RegExp('>' + S.block + '<'));
  });
});
