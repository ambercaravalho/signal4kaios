/* Signal Protocol state storage interface & IndexedDB adapter.
 * Connects the TypeScript Signal engine to App.db (IndexedDB v3) on KaiOS
 * and supports an in-memory store for fast unit tests.
 */

import { fromBase64, toBase64, constantTimeEqual } from './bytes';

export interface KeyPair {
  pubKey: Uint8Array;  // 33-byte (0x05 + 32-byte X25519 public key)
  privKey: Uint8Array; // 32-byte X25519 scalar
}

export interface SignedPreKeyRecord {
  keyId: number;
  keyPair: KeyPair;
  signature: Uint8Array;
  timestamp: number;
}

export interface PreKeyRecord {
  keyId: number;
  keyPair: KeyPair;
}

export type TrustLevel = 'UNTRUSTED' | 'TRUSTED_UNVERIFIED' | 'TRUSTED_VERIFIED';

export interface IdentityRecord {
  address: string;      // UUID/ACI or E164 number
  number?: string;
  uuid?: string;
  publicKey: Uint8Array; // 33-byte identity public key
  trustLevel: TrustLevel;
  addedTimestamp: number;
}

export interface ChainState {
  chainKey: Uint8Array; // 32 bytes
  counter: number;
}

export interface RatchetSessionState {
  sessionVersion: number;
  localIdentityPublic: Uint8Array;
  remoteIdentityPublic: Uint8Array;
  rootKey: Uint8Array;
  sendingChain?: {
    ratchetKeyPair: KeyPair;
    chain: ChainState;
  };
  receivingChains: Array<{
    remoteRatchetKey: Uint8Array;
    chain: ChainState;
    messageKeys: Record<number, Uint8Array>; // counter -> 80-byte derived message keys
  }>;
  previousCounter: number;
   remoteRegistrationId: number;
  localRegistrationId: number;
  pendingPreKey?: {
    preKeyId?: number;
    signedPreKeyId: number;
    baseKey: Uint8Array;
  };
}

export interface SenderKeyState {
  keyId: number;
  iteration: number;
  chainKey: Uint8Array;
  signingKeyPublic: Uint8Array;
  signingKeyPrivate?: Uint8Array;
  messageKeys: Record<number, Uint8Array>;
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
  userAgent?: string;
}

export interface SignalProtocolStore {
  getAccount(): Promise<AccountCredentials | null>;
  saveAccount(creds: AccountCredentials): Promise<void>;

  getIdentityKeyPair(): Promise<KeyPair>;
  getLocalRegistrationId(): Promise<number>;

  getIdentity(address: string): Promise<IdentityRecord | null>;
  saveIdentity(address: string, publicKey: Uint8Array, meta?: { number?: string; uuid?: string }): Promise<boolean>;
  setIdentityTrust(address: string, trustLevel: TrustLevel): Promise<void>;
  getAllIdentities(): Promise<IdentityRecord[]>;

  loadPreKey(keyId: number): Promise<KeyPair | null>;
  storePreKey(keyId: number, keyPair: KeyPair): Promise<void>;
  removePreKey(keyId: number): Promise<void>;

  loadSignedPreKey(keyId: number): Promise<SignedPreKeyRecord | null>;
  storeSignedPreKey(record: SignedPreKeyRecord): Promise<void>;

  loadSession(address: string): Promise<RatchetSessionState | null>;
  storeSession(address: string, session: RatchetSessionState): Promise<void>;
  deleteSession(address: string): Promise<void>;

  loadSenderKey(senderKeyId: string): Promise<SenderKeyState | null>;
  storeSenderKey(senderKeyId: string, state: SenderKeyState): Promise<void>;
}

/* Serialization helpers for storing Uint8Arrays cleanly in IndexedDB / JSON */
function serKeyPair(kp: KeyPair): { pubKey: string; privKey: string } {
  return { pubKey: toBase64(kp.pubKey), privKey: toBase64(kp.privKey) };
}

function deserKeyPair(raw: { pubKey: string; privKey: string }): KeyPair {
  return { pubKey: fromBase64(raw.pubKey), privKey: fromBase64(raw.privKey) };
}

export function serializeSession(s: RatchetSessionState): Record<string, unknown> {
  return {
    sessionVersion: s.sessionVersion,
    localIdentityPublic: toBase64(s.localIdentityPublic),
    remoteIdentityPublic: toBase64(s.remoteIdentityPublic),
    rootKey: toBase64(s.rootKey),
    sendingChain: s.sendingChain
      ? {
          ratchetKeyPair: serKeyPair(s.sendingChain.ratchetKeyPair),
          chain: {
            chainKey: toBase64(s.sendingChain.chain.chainKey),
            counter: s.sendingChain.chain.counter,
          },
        }
      : undefined,
    receivingChains: s.receivingChains.map((rc) => {
      const mks: Record<string, string> = {};
      for (const [k, v] of Object.entries(rc.messageKeys)) {
        mks[k] = toBase64(v);
      }
      return {
        remoteRatchetKey: toBase64(rc.remoteRatchetKey),
        chain: { chainKey: toBase64(rc.chain.chainKey), counter: rc.chain.counter },
        messageKeys: mks,
      };
    }),
    previousCounter: s.previousCounter,
    remoteRegistrationId: s.remoteRegistrationId,
    localRegistrationId: s.localRegistrationId,
    pendingPreKey: s.pendingPreKey
      ? {
          preKeyId: s.pendingPreKey.preKeyId,
          signedPreKeyId: s.pendingPreKey.signedPreKeyId,
          baseKey: toBase64(s.pendingPreKey.baseKey),
        }
      : undefined,
  };
}

export function deserializeSession(raw: any): RatchetSessionState {
  return {
    sessionVersion: raw.sessionVersion || 3,
    localIdentityPublic: fromBase64(raw.localIdentityPublic),
    remoteIdentityPublic: fromBase64(raw.remoteIdentityPublic),
    rootKey: fromBase64(raw.rootKey),
    sendingChain: raw.sendingChain
      ? {
          ratchetKeyPair: deserKeyPair(raw.sendingChain.ratchetKeyPair),
          chain: {
            chainKey: fromBase64(raw.sendingChain.chain.chainKey),
            counter: raw.sendingChain.chain.counter,
          },
        }
      : undefined,
    receivingChains: (raw.receivingChains || []).map((rc: any) => {
      const mks: Record<number, Uint8Array> = {};
      for (const [k, v] of Object.entries(rc.messageKeys || {})) {
        mks[Number(k)] = fromBase64(v as string);
      }
      return {
        remoteRatchetKey: fromBase64(rc.remoteRatchetKey),
        chain: { chainKey: fromBase64(rc.chain.chainKey), counter: rc.chain.counter },
        messageKeys: mks,
      };
    }),
    previousCounter: raw.previousCounter || 0,
    remoteRegistrationId: raw.remoteRegistrationId || 0,
    localRegistrationId: raw.localRegistrationId || 0,
    pendingPreKey: raw.pendingPreKey
      ? {
          preKeyId: raw.pendingPreKey.preKeyId,
          signedPreKeyId: raw.pendingPreKey.signedPreKeyId,
          baseKey: fromBase64(raw.pendingPreKey.baseKey),
        }
      : undefined,
  };
}

/* In-memory store for tests and fallback */
export class MemorySignalStore implements SignalProtocolStore {
  private account: AccountCredentials | null = null;
  private identities = new Map<string, IdentityRecord>();
  private preKeys = new Map<number, KeyPair>();
  private signedPreKeys = new Map<number, SignedPreKeyRecord>();
  private sessions = new Map<string, RatchetSessionState>();
  private senderKeys = new Map<string, SenderKeyState>();

  constructor(account?: AccountCredentials) {
    if (account) this.account = account;
  }

  async getAccount(): Promise<AccountCredentials | null> {
    return this.account;
  }

  async saveAccount(creds: AccountCredentials): Promise<void> {
    this.account = creds;
  }

  async getIdentityKeyPair(): Promise<KeyPair> {
    if (!this.account) throw new Error('Account not initialized');
    return this.account.aciIdentityKeyPair;
  }

  async getLocalRegistrationId(): Promise<number> {
    if (!this.account) throw new Error('Account not initialized');
    return this.account.registrationId;
  }

  async getIdentity(address: string): Promise<IdentityRecord | null> {
    return this.identities.get(address) || null;
  }

  async saveIdentity(
    address: string,
    publicKey: Uint8Array,
    meta?: { number?: string; uuid?: string }
  ): Promise<boolean> {
    const existing = this.identities.get(address);
    const changed = !!(existing && !constantTimeEqual(existing.publicKey, publicKey));
    const trustLevel: TrustLevel = existing
      ? changed
        ? 'UNTRUSTED'
        : existing.trustLevel
      : 'TRUSTED_UNVERIFIED';
    this.identities.set(address, {
      address,
      number: meta?.number || existing?.number,
      uuid: meta?.uuid || existing?.uuid,
      publicKey,
      trustLevel,
      addedTimestamp: existing && !changed ? existing.addedTimestamp : Date.now(),
    });
    return changed;
  }

  async setIdentityTrust(address: string, trustLevel: TrustLevel): Promise<void> {
    const rec = this.identities.get(address);
    if (rec) {
      rec.trustLevel = trustLevel;
      this.identities.set(address, rec);
    }
  }

  async getAllIdentities(): Promise<IdentityRecord[]> {
    return Array.from(this.identities.values());
  }

  async loadPreKey(keyId: number): Promise<KeyPair | null> {
    return this.preKeys.get(keyId) || null;
  }

  async storePreKey(keyId: number, keyPair: KeyPair): Promise<void> {
    this.preKeys.set(keyId, keyPair);
  }

  async removePreKey(keyId: number): Promise<void> {
    this.preKeys.delete(keyId);
  }

  async loadSignedPreKey(keyId: number): Promise<SignedPreKeyRecord | null> {
    return this.signedPreKeys.get(keyId) || null;
  }

  async storeSignedPreKey(record: SignedPreKeyRecord): Promise<void> {
    this.signedPreKeys.set(record.keyId, record);
  }

  async loadSession(address: string): Promise<RatchetSessionState | null> {
    const raw = this.sessions.get(address);
    return raw ? deserializeSession(serializeSession(raw)) : null;
  }

  async storeSession(address: string, session: RatchetSessionState): Promise<void> {
    this.sessions.set(address, deserializeSession(serializeSession(session)));
  }

  async deleteSession(address: string): Promise<void> {
    this.sessions.delete(address);
  }

  async loadSenderKey(senderKeyId: string): Promise<SenderKeyState | null> {
    return this.senderKeys.get(senderKeyId) || null;
  }

  async storeSenderKey(senderKeyId: string, state: SenderKeyState): Promise<void> {
    this.senderKeys.set(senderKeyId, state);
  }
}

/* IndexedDB-backed SignalProtocolStore delegating to App.db on KaiOS */
export class IndexedDbSignalStore implements SignalProtocolStore {
  private cachedAccount: AccountCredentials | null = null;

  private db(): any {
    const g = globalThis as any;
    if (!g.App || !g.App.db) throw new Error('App.db is not initialized');
    return g.App.db;
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
      userAgent: raw.userAgent,
    };
    return this.cachedAccount;
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
      userAgent: creds.userAgent,
    });
  }

  async getIdentityKeyPair(): Promise<KeyPair> {
    const acc = await this.getAccount();
    if (!acc) throw new Error('No linked Signal account');
    return acc.aciIdentityKeyPair;
  }

  async getLocalRegistrationId(): Promise<number> {
    const acc = await this.getAccount();
    if (!acc) throw new Error('No linked Signal account');
    return acc.registrationId;
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

  async saveIdentity(
    address: string,
    publicKey: Uint8Array,
    meta?: { number?: string; uuid?: string }
  ): Promise<boolean> {
    const existing = await this.getIdentity(address);
    const changed = !!(existing && !constantTimeEqual(existing.publicKey, publicKey));
    const trustLevel: TrustLevel = existing
      ? changed
        ? 'UNTRUSTED'
        : existing.trustLevel
      : 'TRUSTED_UNVERIFIED';
    await this.db().putIdentity({
      address,
      number: meta?.number || existing?.number || (address.startsWith('+') ? address : undefined),
      uuid: meta?.uuid || existing?.uuid || (!address.startsWith('+') ? address : undefined),
      publicKey: toBase64(publicKey),
      trustLevel,
      addedTimestamp: existing && !changed ? existing.addedTimestamp : Date.now(),
    });
    return changed;
  }

  async setIdentityTrust(address: string, trustLevel: TrustLevel): Promise<void> {
    const existing = await this.db().getIdentity(address);
    if (existing) {
      existing.trustLevel = trustLevel;
      await this.db().putIdentity(existing);
    }
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

  async loadPreKey(keyId: number): Promise<KeyPair | null> {
    const raw = await this.db().getPreKey('prekey:' + keyId);
    return raw ? deserKeyPair(raw) : null;
  }

  async storePreKey(keyId: number, keyPair: KeyPair): Promise<void> {
    await this.db().putPreKey('prekey:' + keyId, serKeyPair(keyPair));
  }

  async removePreKey(keyId: number): Promise<void> {
    await this.db().deletePreKey('prekey:' + keyId);
  }

  async loadSignedPreKey(keyId: number): Promise<SignedPreKeyRecord | null> {
    const raw = await this.db().getPreKey('signed:' + keyId);
    if (!raw) return null;
    return {
      keyId: raw.keyId,
      keyPair: deserKeyPair(raw.keyPair),
      signature: fromBase64(raw.signature),
      timestamp: raw.timestamp,
    };
  }

  async storeSignedPreKey(record: SignedPreKeyRecord): Promise<void> {
    await this.db().putPreKey('signed:' + record.keyId, {
      keyId: record.keyId,
      keyPair: serKeyPair(record.keyPair),
      signature: toBase64(record.signature),
      timestamp: record.timestamp,
    });
  }

  async loadSession(address: string): Promise<RatchetSessionState | null> {
    const raw = await this.db().getSession(address);
    return raw ? deserializeSession(raw) : null;
  }

  async storeSession(address: string, session: RatchetSessionState): Promise<void> {
    await this.db().putSession(address, serializeSession(session));
  }

  async deleteSession(address: string): Promise<void> {
    await this.db().deleteSession(address);
  }

  async loadSenderKey(senderKeyId: string): Promise<SenderKeyState | null> {
    const raw = await this.db().getSenderKey(senderKeyId);
    if (!raw) return null;
    const mks: Record<number, Uint8Array> = {};
    for (const [k, v] of Object.entries(raw.messageKeys || {})) {
      mks[Number(k)] = fromBase64(v as string);
    }
    return {
      keyId: raw.keyId,
      iteration: raw.iteration,
      chainKey: fromBase64(raw.chainKey),
      signingKeyPublic: fromBase64(raw.signingKeyPublic),
      signingKeyPrivate: raw.signingKeyPrivate ? fromBase64(raw.signingKeyPrivate) : undefined,
      messageKeys: mks,
    };
  }

  async storeSenderKey(senderKeyId: string, state: SenderKeyState): Promise<void> {
    const mks: Record<string, string> = {};
    for (const [k, v] of Object.entries(state.messageKeys || {})) {
      mks[k] = toBase64(v);
    }
    await this.db().putSenderKey(senderKeyId, {
      keyId: state.keyId,
      iteration: state.iteration,
      chainKey: toBase64(state.chainKey),
      signingKeyPublic: toBase64(state.signingKeyPublic),
      signingKeyPrivate: state.signingKeyPrivate ? toBase64(state.signingKeyPrivate) : undefined,
      messageKeys: mks,
    });
  }
}
