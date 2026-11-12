import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes, toBase64, toHex } from '../src/engine/bytes';
import { SyncMessage_StickerPackOperation_Type, SyncMessage_StickerPackOperationSchema } from '../src/engine/gen/SignalService_pb';
import { ChatFolderRecord_FolderType, ManifestRecord_Identifier_Type } from '../src/engine/gen/SignalStorage_pb';
import { create } from '../src/engine/net/proto';
import { groupIdFromMasterKey } from '../src/engine/services/groups-v2';
import { mutateStorage, pullFromStorageService, type StorageMutation } from '../src/engine/services/storage';
import {
  CHAT_FOLDER_DELETED_POSITION,
  chatFolderId,
  type ChatFolderFields,
  ensureAllChatsFolder,
  markChatFolderDeleted,
  writeChatFolder,
} from '../src/engine/services/storage/chat-folders';
import { applyStickerPackOperations, readStickerPack } from '../src/engine/services/storage/sticker-packs';
import { ALICE } from './helpers';
import { serveStorage, storageStore } from './storage-fixture';
import { loadWasmForTests } from './support';

before(() => {
  loadWasmForTests();
});

const SERVER = 'https://chat.signal.org';

function fields(over: Partial<ChatFolderFields> = {}): ChatFolderFields {
  return { name: 'Family', showOnlyUnread: false, showMutedChats: true, includeAllIndividualChats: false, includeAllGroupChats: false, included: [], excluded: [], ...over };
}

describe('chat folder records (Signal-Desktop storageRecordOps)', () => {
  it('creates a folder with the "All chats" folder, edits, reorders, and deletes it', async () => {
    const masterKey = randomBytes(32);
    const store = storageStore(masterKey);
    const srv = await serveStorage(masterKey);
    const write = (m: StorageMutation[]) => mutateStorage(store, srv.httpJson as any, srv.httpBinary, SERVER, m);
    const pull = async () => (await pullFromStorageService(store, srv.httpJson as any, srv.httpBinary, SERVER))!;
    const groupKey = randomBytes(32);
    const id = randomBytes(16);

    await write([
      { type: 'chatFolder', allChats: true, update: ensureAllChatsFolder },
      { type: 'chatFolder', id, update: (f) => writeChatFolder(f, fields({ included: [{ aci: ALICE, e164: '+15553334444' }, { masterKey: groupKey }], excluded: [{ e164: '+15550001111' }] }), 1) },
    ]);
    let res = await pull();
    assert.equal(res.chatFolders.length, 2);
    const [all, family] = res.chatFolders;
    assert.equal(all.all, true);
    assert.equal(all.position, 0);
    assert.equal(all.includeAllIndividualChats && all.includeAllGroupChats && all.showMutedChats, true);
    assert.equal(family.id, toBase64(id));
    assert.equal(family.name, 'Family');
    assert.equal(family.position, 1);
    assert.deepEqual(family.included, [ALICE, '+15553334444', 'g:' + groupIdFromMasterKey(groupKey)]);
    assert.deepEqual(family.excluded, ['+15550001111']);

    await write([
      { type: 'chatFolder', allChats: true, update: ensureAllChatsFolder },
      { type: 'chatFolder', id, update: (f) => writeChatFolder(f, fields({ name: 'Fam', showOnlyUnread: true })) },
    ]);
    res = await pull();
    assert.equal(res.chatFolders.filter((f) => f.all).length, 1, 'a second folder reuses the "All chats" record');
    assert.equal(res.chatFolders[1].name, 'Fam');
    assert.equal(res.chatFolders[1].showOnlyUnread, true);
    assert.equal(res.chatFolders[1].position, 1, 'an edit keeps the position');

    await write([
      { type: 'chatFolder', id, existing: true, update: (f) => { f.position = 0; } },
      { type: 'chatFolder', id: chatFolderId(all.id), existing: true, update: (f) => { f.position = 1; } },
    ]);
    res = await pull();
    assert.deepEqual(res.chatFolders.map((f) => f.all), [false, true]);

    await write([{ type: 'chatFolder', id, existing: true, update: (f) => markChatFolderDeleted(f, 1234) }]);
    res = await pull();
    assert.deepEqual(res.chatFolders.map((f) => f.all), [true]);
    const records = await srv.readRecordsOf(ManifestRecord_Identifier_Type.CHAT_FOLDER);
    const deleted = records.find((r) => r.case === 'chatFolder' && r.value.folderType === ChatFolderRecord_FolderType.CUSTOM);
    assert.ok(deleted && deleted.case === 'chatFolder');
    assert.equal(deleted.value.deletedAtTimestampMs, 1234n);
    assert.equal(deleted.value.position, CHAT_FOLDER_DELETED_POSITION);
    assert.equal(deleted.value.includedRecipients.length, 0);
  });

  it('leaves alone a folder that is gone when deleting or reordering', async () => {
    const masterKey = randomBytes(32);
    const store = storageStore(masterKey);
    const srv = await serveStorage(masterKey);
    const changed = await mutateStorage(store, srv.httpJson as any, srv.httpBinary, SERVER, [{ type: 'chatFolder', id: randomBytes(16), existing: true, update: (f) => markChatFolderDeleted(f, 1) }]);
    assert.equal(changed, false);
    assert.equal(srv.version(), 7n);
  });

  it('rejects folder IDs of the wrong length', () => {
    assert.throws(() => chatFolderId(toBase64(randomBytes(8))));
  });
});

describe('sticker pack records', () => {
  const pack = (n: number) => ({ packId: new Uint8Array(16).fill(n), packKey: new Uint8Array(32).fill(n), position: 0, deletedAtTimestamp: 0n });

  it('skips deleted and malformed packs', () => {
    assert.deepEqual(readStickerPack({ ...pack(1), position: 2 } as any), { id: toHex(new Uint8Array(16).fill(1)), key: toHex(new Uint8Array(32).fill(1)), position: 2 });
    assert.equal(readStickerPack({ ...pack(1), deletedAtTimestamp: 5n } as any), null);
    assert.equal(readStickerPack({ ...pack(1), packKey: new Uint8Array(31) } as any), null);
  });

  it('installs packs last and removes them from the phone\'s sync messages', () => {
    const a = readStickerPack(pack(1) as any)!;
    const op = (type: SyncMessage_StickerPackOperation_Type, n: number) => create(SyncMessage_StickerPackOperationSchema, { packId: new Uint8Array(16).fill(n), packKey: new Uint8Array(32).fill(n), type });
    const added = applyStickerPackOperations([a], [op(SyncMessage_StickerPackOperation_Type.INSTALL, 2)]);
    assert.deepEqual(added.map((p) => [p.id.slice(0, 2), p.position]), [['01', 0], ['02', 1]]);
    const removed = applyStickerPackOperations(added, [op(SyncMessage_StickerPackOperation_Type.REMOVE, 1)]);
    assert.deepEqual(removed.map((p) => p.id.slice(0, 2)), ['02']);
    assert.deepEqual(applyStickerPackOperations(removed, [create(SyncMessage_StickerPackOperationSchema, { packId: new Uint8Array(3) })]), removed, 'a malformed operation changes nothing');
  });
});
