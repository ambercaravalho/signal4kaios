/* Signal Protocol operations, all executed by Signal's official libsignal (via native/libsignal-wasm).
 *
 * Each operation hydrates a short-lived libsignal `ProtocolStore` with exactly the records it needs from the SignalProtocolStore, runs one libsignal call, then writes back whatever libsignal changed (sessions, consumed PreKeys, saved identities, sender keys). Callers must serialize operations that touch the same address; SignalClient does this with a single queue.
 */

import { concatBytes, fromBase64, uuidToBytes } from './bytes';
import { libsignal } from './libsignal';
import type { KeyPair, SignalProtocolStore } from './storage';

/** Signal production sealed-sender trust roots (public keys, from Signal-Desktop config/production.json). */
export const SEALED_SENDER_TRUST_ROOTS = [
  'BXu6QIKVz5MA8gstzfOgRQGqyLqOwNKHL6INkv3IHWMF',
  'BUkY0I+9+oPgDCn4+Ac6Iu813yvqkDr/ga8DzLxFxuk6',
];

export const CIPHERTEXT_WHISPER = 2;
export const CIPHERTEXT_PREKEY = 3;
export const CIPHERTEXT_SENDERKEY = 7;
export const CIPHERTEXT_PLAINTEXT = 8;

export const FINGERPRINT_VERSION = 2;
export const FINGERPRINT_ITERATIONS = 5200;

/** Stable error code of a libsignal failure (`UntrustedIdentity`, `SessionNotFound`, `DuplicatedMessage`, ...), or '' for other errors. */
export function errorCode(e: unknown): string {
  return e && typeof (e as Error).name === 'string' && (e as Error).name !== 'Error' ? (e as Error).name : '';
}

export function protocolError(code: string, message: string): Error {
  const err = new Error(message);
  err.name = code;
  return err;
}

/** Our side of an exchange: the ACI identity for normal traffic, the PNI identity for messages addressed to our phone number. */
export interface LocalIdentity {
  serviceId: string; // ACI uuid, or "PNI:<uuid>"
  deviceId: number;
  keyPair: KeyPair;
  registrationId: number;
}

export async function localIdentity(store: SignalProtocolStore, which: 'aci' | 'pni' = 'aci'): Promise<LocalIdentity> {
  const acc = await store.getAccount();
  if (!acc) throw new Error('This phone is not linked to a Signal account');
  if (which === 'pni') {
    if (!acc.pni || !acc.pniIdentityKeyPair) throw protocolError('InvalidArgument', 'no PNI identity on this device');
    return {
      serviceId: acc.pni.startsWith('PNI:') ? acc.pni : 'PNI:' + acc.pni,
      deviceId: acc.deviceId,
      keyPair: acc.pniIdentityKeyPair,
      registrationId: acc.pniRegistrationId,
    };
  }
  return { serviceId: acc.aci, deviceId: acc.deviceId, keyPair: acc.aciIdentityKeyPair, registrationId: acc.registrationId };
}

interface Hydration {
  identities?: string[];
  sessions?: Array<[string, number]>;
  preKeys?: number[];
  signedPreKeys?: number[];
  kyberPreKeys?: number[];
  senderKeys?: Array<[string, number, string]>;
}

async function hydrate(store: SignalProtocolStore, local: LocalIdentity, h: Hydration): Promise<libsignal.ProtocolStore> {
  const ps = new libsignal.ProtocolStore(local.keyPair.pubKey, local.keyPair.privKey, local.registrationId);
  try {
    for (const name of h.identities || []) {
      const rec = await store.getIdentity(name);
      if (rec) ps.putIdentity(name, rec.publicKey);
    }
    for (const [name, device] of h.sessions || []) {
      const rec = await store.loadSession(name, device);
      if (rec) ps.putSession(name, device, rec);
    }
    for (const id of h.preKeys || []) {
      const rec = await store.loadPreKey(id);
      if (rec) ps.putPreKey(id, rec);
    }
    for (const id of h.signedPreKeys || []) {
      const rec = await store.loadSignedPreKey(id);
      if (rec) ps.putSignedPreKey(id, rec);
    }
    for (const id of h.kyberPreKeys || []) {
      const entry = await store.loadKyberPreKey(id);
      if (entry) ps.putKyberPreKey(id, entry.record);
    }
    for (const [name, device, dist] of h.senderKeys || []) {
      const rec = await store.loadSenderKey(name, device, dist);
      if (rec) ps.putSenderKey(name, device, dist, rec);
    }
    return ps;
  } catch (e) {
    ps.free();
    throw e;
  }
}

interface FlushResult {
  sessions: Array<{ name: string; deviceId: number; record: Uint8Array }>;
  identityChanged: boolean;
}

async function flush(store: SignalProtocolStore, ps: libsignal.ProtocolStore): Promise<FlushResult> {
  let identityChanged = false;
  for (const saved of ps.takeSavedIdentities() as Array<{ name: string; publicKey: Uint8Array }>) {
    const meta = saved.name.startsWith('PNI:') ? {} : { uuid: saved.name };
    if (await store.saveIdentity(saved.name, saved.publicKey, meta)) identityChanged = true;
  }
  const sessions = ps.takeChangedSessions() as Array<{ name: string; deviceId: number; record: Uint8Array }>;
  for (const s of sessions) await store.storeSession(s.name, s.deviceId, s.record);
  for (const id of Array.from(ps.takeRemovedPreKeys())) await store.removePreKey(id);
  for (const id of Array.from(ps.takeUsedKyberPreKeys())) await store.markKyberPreKeyUsed(id);
  for (const sk of ps.takeChangedSenderKeys() as Array<{ name: string; deviceId: number; distributionId: string; record: Uint8Array }>) {
    await store.storeSenderKey(sk.name, sk.deviceId, sk.distributionId, sk.record);
  }
  return { sessions, identityChanged };
}

let lockTail: Promise<unknown> = Promise.resolve();

/** Serializes every load-modify-store cycle so concurrent sends and receives never overwrite each other's session state. */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = lockTail.then(fn, fn);
  lockTail = next.catch(() => undefined);
  return next;
}

/** Runs `op` against a hydrated libsignal store and persists its changes. Nothing is written when `op` throws. */
function run<T>(
  store: SignalProtocolStore,
  local: LocalIdentity,
  h: Hydration,
  op: (ps: libsignal.ProtocolStore) => T
): Promise<{ value: T } & FlushResult> {
  return withLock(async () => {
    const ps = await hydrate(store, local, h);
    try {
      const value = op(ps);
      return { value, ...(await flush(store, ps)) };
    } finally {
      ps.free();
    }
  });
}

/* ---- Session setup and 1:1 encryption ---- */

export interface PreKeyBundle {
  deviceId: number;
  registrationId: number;
  identityKey: Uint8Array;
  preKeyId?: number;
  preKeyPublic?: Uint8Array;
  signedPreKeyId: number;
  signedPreKeyPublic: Uint8Array;
  signedPreKeySignature: Uint8Array;
  kyberPreKeyId: number;
  kyberPreKeyPublic: Uint8Array;
  kyberPreKeySignature: Uint8Array;
}

/** Parses one `GET /v2/keys/{serviceId}/{device}` response into bundles. Devices without a Kyber PreKey are skipped: libsignal only builds PQXDH sessions. */
export function parsePreKeyResponse(json: any): PreKeyBundle[] {
  if (!json || typeof json.identityKey !== 'string' || !Array.isArray(json.devices)) return [];
  const identityKey = fromBase64(json.identityKey);
  const out: PreKeyBundle[] = [];
  for (const d of json.devices) {
    if (!d || !d.signedPreKey || !d.pqPreKey || typeof d.deviceId !== 'number') continue;
    out.push({
      deviceId: d.deviceId,
      registrationId: d.registrationId || 0,
      identityKey,
      preKeyId: d.preKey ? d.preKey.keyId : undefined,
      preKeyPublic: d.preKey ? fromBase64(d.preKey.publicKey) : undefined,
      signedPreKeyId: d.signedPreKey.keyId,
      signedPreKeyPublic: fromBase64(d.signedPreKey.publicKey),
      signedPreKeySignature: fromBase64(d.signedPreKey.signature),
      kyberPreKeyId: d.pqPreKey.keyId,
      kyberPreKeyPublic: fromBase64(d.pqPreKey.publicKey),
      kyberPreKeySignature: fromBase64(d.pqPreKey.signature),
    });
  }
  return out;
}

export async function processPreKeyBundle(
  store: SignalProtocolStore,
  local: LocalIdentity,
  name: string,
  bundle: PreKeyBundle,
  now = Date.now()
): Promise<void> {
  await run(store, local, { identities: [name], sessions: [[name, bundle.deviceId]] }, (ps) =>
    libsignal.sessionProcessPreKeyBundle(
      ps,
      local.serviceId,
      local.deviceId,
      name,
      bundle.deviceId,
      bundle.registrationId,
      bundle.preKeyId,
      bundle.preKeyPublic,
      bundle.signedPreKeyId,
      bundle.signedPreKeyPublic,
      bundle.signedPreKeySignature,
      bundle.kyberPreKeyId,
      bundle.kyberPreKeyPublic,
      bundle.kyberPreKeySignature,
      bundle.identityKey,
      now
    )
  );
}

function remoteRegistrationId(sessions: FlushResult['sessions'], name: string, deviceId: number): number {
  const s = sessions.find((x) => x.name === name && x.deviceId === deviceId);
  if (!s) return 0;
  try {
    return libsignal.sessionRecordRemoteRegistrationId(s.record);
  } catch {
    return 0;
  }
}

/** Encrypts a padded Content for one device: `{ type }` is the envelope type (PREKEY_BUNDLE = 3 or CIPHERTEXT = 1). */
export async function encryptForDevice(
  store: SignalProtocolStore,
  local: LocalIdentity,
  name: string,
  deviceId: number,
  paddedContent: Uint8Array,
  now = Date.now()
): Promise<{ envelopeType: number; body: Uint8Array; registrationId: number }> {
  const res = await run(store, local, { identities: [name], sessions: [[name, deviceId]] }, (ps) =>
    libsignal.sessionEncrypt(ps, local.serviceId, local.deviceId, name, deviceId, paddedContent, now) as {
      type: number;
      body: Uint8Array;
    }
  );
  return {
    envelopeType: res.value.type === CIPHERTEXT_PREKEY ? 3 : 1,
    body: res.value.body,
    registrationId: remoteRegistrationId(res.sessions, name, deviceId),
  };
}

/** Seals a padded Content for one device with our SenderCertificate (envelope type UNIDENTIFIED_SENDER = 6). */
export async function sealedEncryptForDevice(
  store: SignalProtocolStore,
  local: LocalIdentity,
  name: string,
  deviceId: number,
  senderCertificate: Uint8Array,
  paddedContent: Uint8Array,
  now = Date.now()
): Promise<{ body: Uint8Array; registrationId: number }> {
  const res = await run(store, local, { identities: [name], sessions: [[name, deviceId]] }, (ps) =>
    libsignal.sealedSenderEncrypt(ps, name, deviceId, senderCertificate, paddedContent, now)
  );
  return { body: res.value, registrationId: remoteRegistrationId(res.sessions, name, deviceId) };
}

/** True when a session with `name.deviceId` exists and can still send. */
export async function hasUsableSession(store: SignalProtocolStore, name: string, deviceId: number, now = Date.now()): Promise<boolean> {
  const rec = await store.loadSession(name, deviceId);
  if (!rec) return false;
  try {
    return libsignal.sessionRecordHasCurrentState(rec, now);
  } catch {
    return false;
  }
}

/** Archives the current session state so the next send builds a fresh session (END_SESSION, peer DecryptionErrorMessage). */
export function archiveSession(store: SignalProtocolStore, name: string, deviceId: number): Promise<void> {
  return withLock(async () => {
    const rec = await store.loadSession(name, deviceId);
    if (!rec) return;
    try {
      await store.storeSession(name, deviceId, libsignal.sessionRecordArchiveCurrentState(rec));
    } catch {
      await store.deleteSession(name, deviceId);
    }
  });
}

export function deleteSession(store: SignalProtocolStore, name: string, deviceId: number): Promise<void> {
  return withLock(() => store.deleteSession(name, deviceId));
}

/* ---- 1:1 decryption ---- */

export interface DecryptResult {
  plaintext: Uint8Array; // padded Content
  identityChanged: boolean;
}

export async function decryptWhisper(
  store: SignalProtocolStore,
  local: LocalIdentity,
  name: string,
  deviceId: number,
  body: Uint8Array
): Promise<DecryptResult> {
  const res = await run(store, local, { identities: [name], sessions: [[name, deviceId]] }, (ps) =>
    libsignal.sessionDecryptSignal(ps, local.serviceId, local.deviceId, name, deviceId, body)
  );
  return { plaintext: res.value, identityChanged: res.identityChanged };
}

export async function decryptPreKey(
  store: SignalProtocolStore,
  local: LocalIdentity,
  name: string,
  deviceId: number,
  body: Uint8Array
): Promise<DecryptResult> {
  const ids = libsignal.preKeyMessageIds(body) as { preKeyId?: number; signedPreKeyId: number; kyberPreKeyId?: number };
  const res = await run(
    store,
    local,
    {
      identities: [name],
      sessions: [[name, deviceId]],
      preKeys: ids.preKeyId !== undefined ? [ids.preKeyId] : [],
      signedPreKeys: [ids.signedPreKeyId],
      kyberPreKeys: ids.kyberPreKeyId !== undefined ? [ids.kyberPreKeyId] : [],
    },
    (ps) => libsignal.sessionDecryptPreKey(ps, local.serviceId, local.deviceId, name, deviceId, body)
  );
  return { plaintext: res.value, identityChanged: res.identityChanged };
}

/* ---- Sealed Sender ---- */

export interface UnsealedMessage {
  messageType: number; // CIPHERTEXT_* constant for `contents`
  senderUuid: string;
  senderE164?: string;
  senderDeviceId: number;
  contents: Uint8Array;
  contentHint: number;
  groupId?: Uint8Array;
}

let trustRootBytes: Uint8Array | null = null;

function trustRoots(): Uint8Array {
  if (!trustRootBytes) trustRootBytes = concatBytes(...SEALED_SENDER_TRUST_ROOTS.map((r) => fromBase64(r)));
  return trustRootBytes;
}

/** Opens the outer Sealed Sender layer and validates the sender certificate against Signal's trust roots. */
export async function unseal(
  store: SignalProtocolStore,
  local: LocalIdentity,
  body: Uint8Array,
  now = Date.now(),
  roots: Uint8Array = trustRoots()
): Promise<UnsealedMessage> {
  const res = await run(store, local, {}, (ps) => libsignal.sealedSenderDecryptToUsmc(ps, body, roots, now) as UnsealedMessage);
  return res.value;
}

export function senderCertificateExpiration(certificate: Uint8Array): number {
  return (libsignal.senderCertificateInfo(certificate) as { expiration: number }).expiration;
}

/* ---- Sender keys (group receive) ---- */

export async function processSenderKeyDistribution(
  store: SignalProtocolStore,
  local: LocalIdentity,
  name: string,
  deviceId: number,
  skdm: Uint8Array
): Promise<void> {
  const dist = libsignal.senderKeyDistributionMessageDistributionId(skdm);
  await run(store, local, { senderKeys: [[name, deviceId, dist]] }, (ps) =>
    libsignal.processSenderKeyDistributionMessage(ps, name, deviceId, skdm)
  );
}

export async function decryptSenderKey(
  store: SignalProtocolStore,
  local: LocalIdentity,
  name: string,
  deviceId: number,
  body: Uint8Array
): Promise<Uint8Array> {
  const dist = libsignal.senderKeyMessageDistributionId(body);
  const res = await run(store, local, { senderKeys: [[name, deviceId, dist]] }, (ps) =>
    libsignal.groupDecrypt(ps, name, deviceId, body)
  );
  return res.value;
}

/* ---- Retry receipts ---- */

/** Serialized PlaintextContent carrying a DecryptionErrorMessage for a message we could not decrypt (envelope type PLAINTEXT_CONTENT = 8). */
export function decryptionErrorContent(
  originalBody: Uint8Array,
  originalType: number,
  originalTimestamp: number,
  originalSenderDeviceId: number
): Uint8Array {
  return libsignal.decryptionErrorPlaintextContent(originalBody, originalType, originalTimestamp, originalSenderDeviceId);
}

/** Padded Content bytes inside a received PlaintextContent envelope body. */
export function plaintextContentBody(serialized: Uint8Array): Uint8Array {
  return libsignal.plaintextContentBody(serialized);
}

export function parseDecryptionErrorMessage(serialized: Uint8Array): { timestamp: number; deviceId: number; ratchetKey?: Uint8Array } {
  return libsignal.decryptionErrorMessageParse(serialized);
}

/* ---- Safety numbers ---- */

/** 60-digit safety number and the scannable QR payload for our ACI identity vs a remote ACI identity. */
export function safetyNumber(
  localAci: string,
  localIdentityKey: Uint8Array,
  remoteAci: string,
  remoteIdentityKey: Uint8Array
): { safetyNumber: string; scannable: Uint8Array } {
  const fp = libsignal.fingerprintCreate(
    FINGERPRINT_VERSION,
    FINGERPRINT_ITERATIONS,
    uuidToBytes(localAci),
    localIdentityKey,
    uuidToBytes(remoteAci),
    remoteIdentityKey
  ) as { displayable: string; scannable: Uint8Array };
  return { safetyNumber: fp.displayable, scannable: fp.scannable };
}

/** True when a scanned QR payload is the other side's view of the same pair of identities. */
export function compareScannedSafetyNumber(ourScannable: Uint8Array, scanned: Uint8Array): boolean {
  try {
    return libsignal.fingerprintCompare(ourScannable, scanned);
  } catch {
    return false;
  }
}
