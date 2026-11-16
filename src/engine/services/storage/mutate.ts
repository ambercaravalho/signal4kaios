/* Writing the Storage Service like Signal-Desktop: mutations applied to the latest records, a fresh key per changed record, and a manifest at version+1. */

import { constantTimeEqual, randomBytes, toBase64, uuidToBytes } from '../../bytes';
import { sealGcm } from '../../crypto/primitives';
import {
  type AccountRecord,
  AccountRecord_PhoneNumberSharingMode,
  type ChatFolderRecord,
  ChatFolderRecord_FolderType,
  type ContactRecord,
  type GroupV2Record,
  ManifestRecord_Identifier_Type,
  ManifestRecord_IdentifierSchema,
  ManifestRecordSchema,
  OptionalBool,
  type StorageRecord,
  StorageRecordSchema,
  WriteOperationSchema,
} from '../../gen/SignalStorage_pb';
import { DEFAULT_STORAGE_SERVER, SignalHttpBinaryFn, SignalHttpJsonFn } from '../../net/http';
import { create, serviceIdFrom, toBinary } from '../../net/proto';
import type { SignalProtocolStore } from '../../protocol/store';
import { deriveStorageItemKey, deriveStorageManifestKey } from './crypto';
import { loadRemoteState, openSession, saveRecordCache } from './pull';

const WRITE_ATTEMPTS = 3;

export function toOptionalBool(v: boolean | undefined): OptionalBool {
  return v === true ? OptionalBool.ENABLED : v === false ? OptionalBool.DISABLED : OptionalBool.UNSET;
}

/** Writes a group's mentions-while-muted setting like Signal-Desktop, keeping the deprecated field in step for older clients. */
export function setNotifyForMentionsIfMuted(g: GroupV2Record, notify: boolean | undefined): void {
  g.notifyForMentionsIfMuted = toOptionalBool(notify);
  g.dontNotifyForMentionsIfMuted = notify === false;
}

/** One change to a Storage Service record. A missing contact or group record is created; the account record must already exist. */
export type StorageMutation =
  | { type: 'contact'; aci?: string; e164?: string; update: (c: ContactRecord) => void }
  | { type: 'groupV2'; masterKey: Uint8Array; update: (g: GroupV2Record) => void }
  | { type: 'account'; update: (a: AccountRecord) => void }
  /** A chat folder by its 16-byte ID, or with `allChats` the "All chats" folder, whatever its ID (a new one gets a random ID). With `existing`, a folder that isn't there is left alone rather than created. */
  | { type: 'chatFolder'; id?: Uint8Array; allChats?: boolean; existing?: boolean; update: (f: ChatFolderRecord) => void };

/** Who sees and who can find us by our number, written like Signal-Desktop: sharing with everybody also makes the number findable. */
export function setPhoneNumberPrivacy(a: AccountRecord, share: boolean, findable: boolean): void {
  a.phoneNumberSharingMode = share ? AccountRecord_PhoneNumberSharingMode.EVERYBODY : AccountRecord_PhoneNumberSharingMode.NOBODY;
  a.unlistedPhoneNumber = !(share || findable);
}

interface WorkingRecord {
  key: Uint8Array | null;
  type: ManifestRecord_Identifier_Type;
  record: StorageRecord;
  before: Uint8Array | null;
}

function findWorking(list: WorkingRecord[], m: StorageMutation): WorkingRecord | undefined {
  return list.find(({ record: { record: r } }) => {
    if (m.type === 'account') return r.case === 'account';
    if (m.type === 'groupV2') return r.case === 'groupV2' && constantTimeEqual(r.value.masterKey, m.masterKey);
    if (m.type === 'chatFolder') {
      if (r.case !== 'chatFolder') return false;
      if (m.allChats) return r.value.folderType === ChatFolderRecord_FolderType.ALL && r.value.deletedAtTimestampMs === 0n;
      return !!m.id && constantTimeEqual(r.value.id, m.id);
    }
    if (r.case !== 'contact') return false;
    const aci = serviceIdFrom(r.value.aci, r.value.aciBinary);
    if (aci && m.aci) return aci === m.aci;
    return !!m.e164 && r.value.e164 === m.e164;
  });
}

function newWorking(m: StorageMutation): WorkingRecord {
  if (m.type === 'account') throw new Error('Storage Service has no account record yet');
  if (m.type === 'chatFolder') {
    const id = m.id && m.id.length === 16 ? m.id : randomBytes(16);
    return {
      key: null,
      type: ManifestRecord_Identifier_Type.CHAT_FOLDER,
      record: create(StorageRecordSchema, { record: { case: 'chatFolder', value: { id } } }),
      before: null,
    };
  }
  if (m.type === 'groupV2') {
    return {
      key: null,
      type: ManifestRecord_Identifier_Type.GROUPV2,
      record: create(StorageRecordSchema, { record: { case: 'groupV2', value: { masterKey: m.masterKey } } }),
      before: null,
    };
  }
  if (!m.aci && !m.e164) throw new Error('A contact record needs an ACI or a phone number');
  return {
    key: null,
    type: ManifestRecord_Identifier_Type.CONTACT,
    record: create(StorageRecordSchema, {
      record: {
        case: 'contact',
        value: { aci: m.aci || '', aciBinary: m.aci ? uuidToBytes(m.aci) : undefined, e164: m.e164 || '' },
      },
    }),
    before: null,
  };
}

function applyMutation(w: WorkingRecord, m: StorageMutation): void {
  const r = w.record.record;
  if (m.type === 'contact' && r.case === 'contact') m.update(r.value);
  else if (m.type === 'groupV2' && r.case === 'groupV2') m.update(r.value);
  else if (m.type === 'account' && r.case === 'account') m.update(r.value);
  else if (m.type === 'chatFolder' && r.case === 'chatFolder') m.update(r.value);
}

/**
 * Apply `mutations` to the latest Storage Service records and write them back like Signal-Desktop: every changed record gets a fresh random 16-byte key, the old key is deleted, and a manifest at version+1 lists the new keys alongside every identifier we don't touch (including record types we never read). A 409 means another device wrote first, so the state is re-read and the mutations re-applied. Resolves to false when nothing changed.
 */
export async function mutateStorage(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  httpBinary: SignalHttpBinaryFn,
  serverUrl: string,
  mutations: StorageMutation[],
  storageUrl = DEFAULT_STORAGE_SERVER
): Promise<boolean> {
  if (mutations.length === 0) return false;
  for (let attempt = 0; ; attempt++) {
    const session = await openSession(store, httpJson, serverUrl, storageUrl);
    if (!session) throw new Error('Storage Service needs the account master key; sync with your phone first');
    const remote = await loadRemoteState(store, session, httpBinary);
    if (!remote) throw new Error('Storage Service has no manifest yet');

    const working: WorkingRecord[] = [];
    for (const id of remote.manifest.identifiers) {
      const rec = id.raw.length ? remote.records.get(toBase64(id.raw)) : undefined;
      if (rec) working.push({ key: id.raw, type: id.type, record: rec, before: toBinary(StorageRecordSchema, rec) });
    }
    for (const m of mutations) {
      let w = findWorking(working, m);
      if (!w) {
        if (m.type === 'chatFolder' && m.existing) continue;
        w = newWorking(m);
        working.push(w);
      }
      applyMutation(w, m);
    }

    const changed = working.filter((w) => {
      const now = toBinary(StorageRecordSchema, w.record);
      return !w.before || !constantTimeEqual(w.before, now);
    });
    if (changed.length === 0) return false;

    const manifest = remote.manifest;
    const newVersion = manifest.version + 1n;
    const deleteKey = changed.filter((w) => w.key).map((w) => w.key!);
    const deleted = new Set(deleteKey.map(toBase64));
    const insertItem = [];
    const nextRecords = new Map(remote.records);
    for (const k of deleted) nextRecords.delete(k);
    const identifiers = manifest.identifiers.filter((id) => !deleted.has(toBase64(id.raw)));
    for (const w of changed) {
      const key = randomBytes(16);
      const plain = toBinary(StorageRecordSchema, w.record);
      const itemKey = deriveStorageItemKey(session.storageKey, key, manifest.recordIkm);
      insertItem.push({ key, value: await sealGcm(itemKey, plain) });
      identifiers.push(create(ManifestRecord_IdentifierSchema, { raw: key, type: w.type }));
      nextRecords.set(toBase64(key), w.record);
    }
    manifest.version = newVersion;
    manifest.sourceDevice = session.deviceId;
    manifest.identifiers = identifiers;

    const manifestValue = await sealGcm(
      deriveStorageManifestKey(session.storageKey, newVersion),
      toBinary(ManifestRecordSchema, manifest)
    );
    const writeOp = create(WriteOperationSchema, {
      manifest: { version: newVersion, value: manifestValue },
      insertItem,
      deleteKey,
    });
    try {
      await httpBinary('PUT', `${storageUrl}/v1/storage`, toBinary(WriteOperationSchema, writeOp), session.headers, 30000);
    } catch (err: any) {
      if (err && err.status === 409 && attempt + 1 < WRITE_ATTEMPTS) continue;
      throw err;
    }
    await saveRecordCache(store, nextRecords);
    return true;
  }
}

/** A call that made Storage Service mutations, saved so it can be made again if Beacon closes before they are written. `args` are JSON-safe. */
export interface StorageReplay {
  id: string;
  method: string;
  args: unknown[];
}

/** Where saved calls are kept between runs. */
export interface StorageJournal {
  load(): Promise<StorageReplay[]>;
  save(list: StorageReplay[]): Promise<void>;
}

let replayCounter = 0;

/**
 * Batches Storage Service mutations: changes queued within `delayMs` go out as one manifest write, and writes never overlap. `onWritten` runs after each write that changed something. Calls queued with a replay are kept in `journal` until their write succeeds.
 */
export class StorageWriteQueue {
  private pending: StorageMutation[] = [];
  private pendingReplays: StorageReplay[] = [];
  /** Saved calls this run has queued or is writing; a replay skips them. */
  private live = new Set<string>();
  private batch: Promise<void> | null = null;
  private settle: { resolve: () => void; reject: (e: unknown) => void } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private journalChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly write: (mutations: StorageMutation[]) => Promise<boolean>,
    private readonly onWritten: () => void,
    private readonly delayMs = 1500,
    private readonly journal?: StorageJournal
  ) {}

  enqueue(mutations: StorageMutation[], replay?: { method: string; args: unknown[] }): Promise<void> {
    if (replay && this.journal) {
      const entry: StorageReplay = { id: Date.now().toString(36) + '.' + (replayCounter++).toString(36), method: replay.method, args: replay.args };
      this.live.add(entry.id);
      this.pendingReplays.push(entry);
      this.updateJournal((list) => list.concat([entry]));
    }
    this.pending.push(...mutations);
    return this.schedule();
  }

  /** Write what is queued now instead of after the delay; resolves once every write so far has finished. */
  flush(): Promise<void> {
    if (!this.batch) return this.chain.then(() => undefined);
    const batch = this.batch;
    this.run();
    return batch;
  }

  /** Queue the saved calls left from an earlier run, oldest first and ahead of anything newer, and write them now. A call `build` can't turn into mutations is dropped. */
  async replaySaved(build: (r: StorageReplay) => StorageMutation[] | Promise<StorageMutation[]>): Promise<void> {
    if (!this.journal) return;
    await this.journalChain;
    const saved = (await this.journal.load()).filter((r) => r && !this.live.has(r.id));
    if (!saved.length) return;
    const muts: StorageMutation[] = [];
    const replays: StorageReplay[] = [];
    const dropped = new Set<string>();
    for (const r of saved) {
      try {
        muts.push(...(await build(r)));
        replays.push(r);
        this.live.add(r.id);
      } catch {
        dropped.add(r.id);
      }
    }
    if (dropped.size) this.updateJournal((list) => list.filter((r) => !dropped.has(r.id)));
    if (!replays.length) return;
    this.pending = muts.concat(this.pending);
    this.pendingReplays = replays.concat(this.pendingReplays);
    const batch = this.schedule();
    this.run();
    await batch;
  }

  private schedule(): Promise<void> {
    if (!this.batch) {
      this.batch = new Promise<void>((resolve, reject) => {
        this.settle = { resolve, reject };
      });
      this.timer = setTimeout(() => this.run(), this.delayMs);
    }
    return this.batch;
  }

  private run(): void {
    if (!this.settle) return;
    if (this.timer) clearTimeout(this.timer);
    const { resolve, reject } = this.settle;
    const muts = this.pending;
    const replays = this.pendingReplays;
    this.pending = [];
    this.pendingReplays = [];
    this.batch = null;
    this.settle = null;
    this.timer = null;
    const job = this.chain.then(() => this.write(muts));
    this.chain = job.catch(() => undefined);
    job.then(
      (changed) => {
        this.forget(replays, true);
        if (changed) this.onWritten();
        resolve();
      },
      (e) => {
        this.forget(replays, false);
        reject(e);
      }
    );
  }

  /** After a write: a written call leaves the journal; a failed one stays there for the next replay. */
  private forget(replays: StorageReplay[], written: boolean): void {
    if (!replays.length) return;
    for (const r of replays) this.live.delete(r.id);
    if (!written) return;
    const done = new Set(replays.map((r) => r.id));
    this.updateJournal((list) => list.filter((r) => !done.has(r.id)));
  }

  private updateJournal(change: (list: StorageReplay[]) => StorageReplay[]): void {
    const journal = this.journal;
    if (!journal) return;
    this.journalChain = this.journalChain
      .then(async () => {
        const list = await journal.load();
        await journal.save(change(Array.isArray(list) ? list : []));
      })
      .catch(() => undefined);
  }
}
