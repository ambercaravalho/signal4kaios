/* Signal Protocol state storage: account credentials plus opaque, serialized libsignal records (sessions, PreKeys, sender keys) and remote identity keys with trust levels.
 * Records are produced and consumed only by libsignal (protocol/protocol.ts); this layer never parses them. IndexedDbSignalStore persists to the app's IndexedDB (v4) on KaiOS, MemorySignalStore backs the unit tests.
 */

import { constantTimeEqual, fromBase64, toBase64 } from '../bytes';
import { host } from '../host';

export interface KeyPair {
  pubKey: Uint8Array; // 33-byte serialized public key (0x05 || X25519)
  privKey: Uint8Array; // 32-byte private scalar
}

export type TrustLevel = 'UNTRUSTED' | 'TRUSTED_UNVERIFIED' | 'TRUSTED_VERIFIED';

export interface IdentityRecord {
  address: string; // ACI (or PNI as "PNI:<uuid>")
  number?: string;
  uuid?: string;
  publicKey: Uint8Array; // 33-byte identity public key
  trustLevel: TrustLevel;
  addedTimestamp: number;
}

export interface KyberPreKeyEntry {
  record: Uint8Array;
  lastResort: boolean;
}

export interface SessionEntry {
  deviceId: number;
  record: Uint8Array;
}

export interface AccountCredentials {
  aci: string;
  pni?: string;
  number: string;
  deviceId: number;
  password: string; // SECURITY-REVIEW: Signal device signaling password stored in IndexedDB only
  registrationId: number;
  pniRegistrationId: number;
  aciIdentityKeyPair: KeyPair;
  pniIdentityKeyPair?: KeyPair;
  profileKey?: Uint8Array;
  masterKey?: Uint8Array; // SECURITY-REVIEW: account master key (derived from the Account Entropy Pool); unlocks Storage Service
  accountEntropyPool?: string; // SECURITY-REVIEW: root account secret from the primary device; never logged
  userAgent?: string;
}

export interface SignalProtocolStore {
  getAccount(): Promise<AccountCredentials | null>;
  saveAccount(creds: AccountCredentials): Promise<void>;
  /** Drop any in-memory copy of the account so the next read comes from the backing database. */
  forgetCachedAccount(): void;

  /** Small JSON-safe engine bookkeeping values (PreKey ID counters and similar), never key material. */
  loadValue<T>(key: string): Promise<T | undefined>;
  storeValue<T>(key: string, value: T): Promise<void>;

  getIdentity(address: string): Promise<IdentityRecord | null>;
  /** Stores `publicKey` for `address`; returns true when it replaced a different key (the trust level then drops to UNTRUSTED until the user reviews the new safety number). */
  saveIdentity(address: string, publicKey: Uint8Array, meta?: { number?: string; uuid?: string }): Promise<boolean>;
  setIdentityTrust(address: string, trustLevel: TrustLevel): Promise<void>;
  removeIdentity(address: string): Promise<void>;
  getAllIdentities(): Promise<IdentityRecord[]>;

  loadPreKey(id: number): Promise<Uint8Array | null>;
  storePreKey(id: number, record: Uint8Array): Promise<void>;
  removePreKey(id: number): Promise<void>;

  loadSignedPreKey(id: number): Promise<Uint8Array | null>;
  storeSignedPreKey(id: number, record: Uint8Array): Promise<void>;

  loadKyberPreKey(id: number): Promise<KyberPreKeyEntry | null>;
  storeKyberPreKey(id: number, record: Uint8Array, lastResort: boolean): Promise<void>;
  /** One-time Kyber PreKeys are deleted once used; last-resort keys are kept. */
  markKyberPreKeyUsed(id: number): Promise<void>;

  loadSession(name: string, deviceId: number): Promise<Uint8Array | null>;
  storeSession(name: string, deviceId: number, record: Uint8Array): Promise<void>;
  deleteSession(name: string, deviceId: number): Promise<void>;
  /** Every stored session for `name`, across devices. */
  loadSessions(name: string): Promise<SessionEntry[]>;

  loadSenderKey(name: string, deviceId: number, distributionId: string): Promise<Uint8Array | null>;
  storeSenderKey(name: string, deviceId: number, distributionId: string, record: Uint8Array): Promise<void>;
}

function sessionKey(name: string, deviceId: number): string {
  return `${name}.${deviceId}`;
}

function senderKeyKey(name: string, deviceId: number, distributionId: string): string {
  return `${name}.${deviceId}::${distributionId}`;
}

function nextIdentity(
  address: string,
  publicKey: Uint8Array,
  existing: IdentityRecord | null,
  meta?: { number?: string; uuid?: string }
): { record: IdentityRecord; changed: boolean } {
  const changed = !!(existing && !constantTimeEqual(existing.publicKey, publicKey));
  const trustLevel: TrustLevel = existing ? (changed ? 'UNTRUSTED' : existing.trustLevel) : 'TRUSTED_UNVERIFIED';
  return {
    changed,
    record: {
      address,
      number: meta?.number || existing?.number || (address.startsWith('+') ? address : undefined),
      uuid: meta?.uuid || existing?.uuid || (!address.startsWith('+') ? address : undefined),
      publicKey,
      trustLevel,
      addedTimestamp: existing && !changed ? existing.addedTimestamp : Date.now(),
    },
  };
}

/* In-memory store for tests */
export class MemorySignalStore implements SignalProtocolStore {
  private account: AccountCredentials | null = null;
  private identities = new Map<string, IdentityRecord>();
  private preKeys = new Map<number, Uint8Array>();
  private signedPreKeys = new Map<number, Uint8Array>();
  private kyberPreKeys = new Map<number, KyberPreKeyEntry>();
  private sessions = new Map<string, { name: string; deviceId: number; record: Uint8Array }>();
  private senderKeys = new Map<string, Uint8Array>();
  private values = new Map<string, unknown>();

  constructor(account?: AccountCredentials) {
    if (account) this.account = account;
  }

  async getAccount(): Promise<AccountCredentials | null> {
    return this.account;
  }

  async saveAccount(creds: AccountCredentials): Promise<void> {
    this.account = creds;
  }

  forgetCachedAccount(): void {}

  async loadValue<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async storeValue<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async getIdentity(address: string): Promise<IdentityRecord | null> {
    return this.identities.get(address) || null;
  }

  async saveIdentity(address: string, publicKey: Uint8Array, meta?: { number?: string; uuid?: string }): Promise<boolean> {
    const { record, changed } = nextIdentity(address, publicKey, this.identities.get(address) || null, meta);
    this.identities.set(address, record);
    return changed;
  }

  async setIdentityTrust(address: string, trustLevel: TrustLevel): Promise<void> {
    const rec = this.identities.get(address);
    if (rec) rec.trustLevel = trustLevel;
  }

  async removeIdentity(address: string): Promise<void> {
    this.identities.delete(address);
  }

  async getAllIdentities(): Promise<IdentityRecord[]> {
    return Array.from(this.identities.values());
  }

  async loadPreKey(id: number): Promise<Uint8Array | null> {
    return this.preKeys.get(id) || null;
  }

  async storePreKey(id: number, record: Uint8Array): Promise<void> {
    this.preKeys.set(id, record);
  }

  async removePreKey(id: number): Promise<void> {
    this.preKeys.delete(id);
  }

  async loadSignedPreKey(id: number): Promise<Uint8Array | null> {
    return this.signedPreKeys.get(id) || null;
  }

  async storeSignedPreKey(id: number, record: Uint8Array): Promise<void> {
    this.signedPreKeys.set(id, record);
  }

  async loadKyberPreKey(id: number): Promise<KyberPreKeyEntry | null> {
    return this.kyberPreKeys.get(id) || null;
  }

  async storeKyberPreKey(id: number, record: Uint8Array, lastResort: boolean): Promise<void> {
    this.kyberPreKeys.set(id, { record, lastResort });
  }

  async markKyberPreKeyUsed(id: number): Promise<void> {
    const entry = this.kyberPreKeys.get(id);
    if (entry && !entry.lastResort) this.kyberPreKeys.delete(id);
  }

  async loadSession(name: string, deviceId: number): Promise<Uint8Array | null> {
    const entry = this.sessions.get(sessionKey(name, deviceId));
    return entry ? entry.record : null;
  }

  async storeSession(name: string, deviceId: number, record: Uint8Array): Promise<void> {
    this.sessions.set(sessionKey(name, deviceId), { name, deviceId, record });
  }

  async deleteSession(name: string, deviceId: number): Promise<void> {
    this.sessions.delete(sessionKey(name, deviceId));
  }

  async loadSessions(name: string): Promise<SessionEntry[]> {
    const out: SessionEntry[] = [];
    this.sessions.forEach((entry) => {
      if (entry.name === name) out.push({ deviceId: entry.deviceId, record: entry.record });
    });
    return out;
  }

  async loadSenderKey(name: string, deviceId: number, distributionId: string): Promise<Uint8Array | null> {
    return this.senderKeys.get(senderKeyKey(name, deviceId, distributionId)) || null;
  }

  async storeSenderKey(name: string, deviceId: number, distributionId: string, record: Uint8Array): Promise<void> {
    this.senderKeys.set(senderKeyKey(name, deviceId, distributionId), record);
  }
}

function serKeyPair(kp: KeyPair): { pubKey: string; privKey: string } {
  return { pubKey: toBase64(kp.pubKey), privKey: toBase64(kp.privKey) };
}

function deserKeyPair(raw: { pubKey: string; privKey: string }): KeyPair {
  return { pubKey: fromBase64(raw.pubKey), privKey: fromBase64(raw.privKey) };
}

function toRecord(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return null;
}

/* IndexedDB-backed store delegating to the app's database (the engine host's `db`) on KaiOS. Records are stored as Uint8Array values (structured clone), not JSON. */
export class IndexedDbSignalStore implements SignalProtocolStore {
  private cachedAccount: AccountCredentials | null = null;

  private db(): any {
    return host().db;
  }

  async getAccount(): Promise<AccountCredentials | null> {
    if (this.cachedAccount) return this.cachedAccount;
    const raw = await this.db().signalKeyGet('account');
    if (!raw) return null;
    this.cachedAccount = {
      aci: raw.aci,
      pni: raw.pni,
      number: raw.number,
      deviceId: raw.deviceId,
      password: raw.password,
      registrationId: raw.registrationId,
      pniRegistrationId: raw.pniRegistrationId || raw.registrationId,
      aciIdentityKeyPair: deserKeyPair(raw.aciIdentityKeyPair),
      pniIdentityKeyPair: raw.pniIdentityKeyPair ? deserKeyPair(raw.pniIdentityKeyPair) : undefined,
      profileKey: raw.profileKey ? fromBase64(raw.profileKey) : undefined,
      masterKey: raw.masterKey ? fromBase64(raw.masterKey) : undefined,
      accountEntropyPool: raw.accountEntropyPool,
      userAgent: raw.userAgent,
    };
    return this.cachedAccount;
  }

  forgetCachedAccount(): void {
    this.cachedAccount = null;
  }

  async saveAccount(creds: AccountCredentials): Promise<void> {
    this.cachedAccount = creds;
    await this.db().signalKeySet('account', {
      aci: creds.aci,
      pni: creds.pni,
      number: creds.number,
      deviceId: creds.deviceId,
      password: creds.password,
      registrationId: creds.registrationId,
      pniRegistrationId: creds.pniRegistrationId,
      aciIdentityKeyPair: serKeyPair(creds.aciIdentityKeyPair),
      pniIdentityKeyPair: creds.pniIdentityKeyPair ? serKeyPair(creds.pniIdentityKeyPair) : undefined,
      profileKey: creds.profileKey ? toBase64(creds.profileKey) : undefined,
      masterKey: creds.masterKey ? toBase64(creds.masterKey) : undefined,
      accountEntropyPool: creds.accountEntropyPool,
      userAgent: creds.userAgent,
    });
  }

  async loadValue<T>(key: string): Promise<T | undefined> {
    return (await this.db().signalKeyGet('value:' + key)) as T | undefined;
  }

  async storeValue<T>(key: string, value: T): Promise<void> {
    await this.db().signalKeySet('value:' + key, value);
  }

  async getIdentity(address: string): Promise<IdentityRecord | null> {
    const raw = await this.db().getIdentity(address);
    if (!raw) return null;
    return {
      address: raw.address,
      number: raw.number,
      uuid: raw.uuid,
      publicKey: fromBase64(raw.publicKey),
      trustLevel: raw.trustLevel || 'TRUSTED_UNVERIFIED',
      addedTimestamp: raw.addedTimestamp || 0,
    };
  }

  async saveIdentity(address: string, publicKey: Uint8Array, meta?: { number?: string; uuid?: string }): Promise<boolean> {
    const { record, changed } = nextIdentity(address, publicKey, await this.getIdentity(address), meta);
    await this.db().putIdentity({ ...record, publicKey: toBase64(record.publicKey) });
    return changed;
  }

  async setIdentityTrust(address: string, trustLevel: TrustLevel): Promise<void> {
    const existing = await this.db().getIdentity(address);
    if (existing) {
      existing.trustLevel = trustLevel;
      await this.db().putIdentity(existing);
    }
  }

  async removeIdentity(address: string): Promise<void> {
    await this.db().deleteIdentity(address);
  }

  async getAllIdentities(): Promise<IdentityRecord[]> {
    const rows = (await this.db().allIdentities()) || [];
    return rows.map((r: any) => ({
      address: r.address,
      number: r.number,
      uuid: r.uuid,
      publicKey: fromBase64(r.publicKey),
      trustLevel: r.trustLevel || 'TRUSTED_UNVERIFIED',
      addedTimestamp: r.addedTimestamp || 0,
    }));
  }

  async loadPreKey(id: number): Promise<Uint8Array | null> {
    return toRecord(await this.db().getPreKey('prekey:' + id));
  }

  async storePreKey(id: number, record: Uint8Array): Promise<void> {
    await this.db().putPreKey('prekey:' + id, record);
  }

  async removePreKey(id: number): Promise<void> {
    await this.db().deletePreKey('prekey:' + id);
  }

  async loadSignedPreKey(id: number): Promise<Uint8Array | null> {
    return toRecord(await this.db().getPreKey('signed:' + id));
  }

  async storeSignedPreKey(id: number, record: Uint8Array): Promise<void> {
    await this.db().putPreKey('signed:' + id, record);
  }

  async loadKyberPreKey(id: number): Promise<KyberPreKeyEntry | null> {
    const raw = await this.db().getPreKey('kyber:' + id);
    const record = raw ? toRecord(raw.record) : null;
    return record ? { record, lastResort: !!raw.lastResort } : null;
  }

  async storeKyberPreKey(id: number, record: Uint8Array, lastResort: boolean): Promise<void> {
    await this.db().putPreKey('kyber:' + id, { record, lastResort });
  }

  async markKyberPreKeyUsed(id: number): Promise<void> {
    const entry = await this.loadKyberPreKey(id);
    if (entry && !entry.lastResort) await this.db().deletePreKey('kyber:' + id);
  }

  async loadSession(name: string, deviceId: number): Promise<Uint8Array | null> {
    return toRecord(await this.db().getSession(sessionKey(name, deviceId)));
  }

  async storeSession(name: string, deviceId: number, record: Uint8Array): Promise<void> {
    await this.db().putSession(sessionKey(name, deviceId), record);
  }

  async deleteSession(name: string, deviceId: number): Promise<void> {
    await this.db().deleteSession(sessionKey(name, deviceId));
  }

  async loadSessions(name: string): Promise<SessionEntry[]> {
    const rows: Array<{ address: string; data: unknown }> = (await this.db().allSessions()) || [];
    const prefix = name + '.';
    const out: SessionEntry[] = [];
    for (const row of rows) {
      if (!row.address || !row.address.startsWith(prefix)) continue;
      const deviceId = Number(row.address.slice(prefix.length));
      const record = toRecord(row.data);
      if (Number.isInteger(deviceId) && deviceId > 0 && record) out.push({ deviceId, record });
    }
    return out;
  }

  async loadSenderKey(name: string, deviceId: number, distributionId: string): Promise<Uint8Array | null> {
    return toRecord(await this.db().getSenderKey(senderKeyKey(name, deviceId, distributionId)));
  }

  async storeSenderKey(name: string, deviceId: number, distributionId: string, record: Uint8Array): Promise<void> {
    await this.db().putSenderKey(senderKeyKey(name, deviceId, distributionId), record);
  }
}
