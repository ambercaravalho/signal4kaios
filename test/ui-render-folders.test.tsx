import './ui-env';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'preact-render-to-string';

import { router, RouterView } from '../src/ui/app/router';
import { config } from '../src/ui/data/config';
import { db } from '../src/ui/data/db';
import * as store from '../src/ui/data/store';
import { HistoryScreen } from '../src/ui/screens/History';
import { HomeScreen } from '../src/ui/screens/Home';
import { ChatFoldersScreen } from '../src/ui/screens/settings/ChatFolders';
import { ChatsSettingsScreen } from '../src/ui/screens/settings/Chats';
import { EditFolderScreen } from '../src/ui/screens/settings/EditFolder';
import { fmt, S } from '../src/ui/strings';
import { settle } from './helpers';

const ME = '+15550000';
const ALICE = '+15550001';
const BOB = '+15550002';

const html = () => renderToString(<RouterView />);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const family = { id: 'ZmFtaWx5', name: 'Family', position: 1, all: false, showOnlyUnread: false, showMutedChats: true, includeAllIndividualChats: false, includeAllGroupChats: false, included: [ALICE], excluded: [] };

describe('history and chat folder screens', () => {
  before(async () => {
    config.set({ number: ME, aci: '00000000-0000-4000-8000-000000000000', deviceId: 2, deviceToken: 'test-only' });
    await db.ready();
    await db.kvSet('syncedContacts', [
      { uuid: '', number: ALICE, name: 'Alice' },
      { uuid: '', number: BOB, name: 'Bob' },
    ]);
    await store.refreshDirectory();
    for (const [n, ts] of [[ALICE, 1000], [BOB, 2000]] as const) store.ingestRaw({ envelope: { sourceNumber: n, timestamp: ts, dataMessage: { timestamp: ts, message: 'hi from ' + n } } });
    await settle();
  });

  it('waits for the phone while history is on its way', () => {
    router.reset(HistoryScreen, {});
    const out = html();
    assert.match(out, new RegExp(S.historyTitle));
    assert.match(out, new RegExp(escape(S.historyWaiting)));
    assert.match(out, new RegExp(S.historyWaitingHint));
  });

  it('shows the plain chat list until there are folders, then names the folder', () => {
    config.set({ chatFolders: [] });
    router.reset(HomeScreen, {});
    assert.doesNotMatch(html(), new RegExp(escape(fmt(S.folderTitle, { name: S.allChats }))));
    config.set({ chatFolders: [family] });
    router.reset(HomeScreen, {});
    const out = html();
    assert.match(out, new RegExp(escape(fmt(S.folderTitle, { name: S.allChats }))));
    assert.match(out, /Alice/);
    assert.match(out, /Bob/);
  });

  it('lists folders in order with how many chats each holds', () => {
    config.set({ chatFolders: [family] });
    router.reset(ChatFoldersScreen, {});
    const out = html().replace(/<[^>]+>/g, ' ');
    assert.match(out, new RegExp(S.addFolder));
    assert.ok(out.indexOf(S.allChats) < out.indexOf('Family'));
    assert.match(out, /2 chats[^]*1 chat\b/);
    router.reset(ChatsSettingsScreen, {});
    assert.match(html(), new RegExp(S.chatFolders + '[^]*2 folders'));
  });

  it('edits a folder\'s name, chats, and filters', () => {
    router.reset(EditFolderScreen, { folder: family });
    let out = html();
    assert.match(out, new RegExp(S.editFolder));
    assert.match(out, /Family/);
    assert.match(out, new RegExp(S.includedChats + '[^]*1 chat\\b[^]*' + S.excludedChats + '[^]*0 chats'));
    assert.match(out, new RegExp(S.showMutedChats));
    router.reset(EditFolderScreen, { folder: undefined });
    out = html();
    assert.match(out, new RegExp(S.newFolder));
    assert.match(out, new RegExp(S.noFolderName));
  });
});
