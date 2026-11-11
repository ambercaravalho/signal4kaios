/* Linked Device QR Provisioning & Initial PreKey Registration, following Signal-Desktop (ts/textsecure/AccountManager, WebAPI linkDevice).
 *
 * 1. Connect to wss://chat.signal.org/v1/websocket/provisioning/ and create a libsignal provisioning receiver (ephemeral key pair).
 * 2. Receive `PUT /v1/address` -> ProvisioningAddress { address } and show `sgnl://linkdevice?uuid=<address>&pub_key=<base64(pubKey)>` as a QR code.
 * 3. Receive `PUT /v1/message` -> ProvisionEnvelope, decrypted by libsignal's provisioning cipher into a ProvisionMessage.
 * 4. Link via `PUT /v1/devices/link` (Basic auth aci:newPassword) with the encrypted device name and signed + last-resort Kyber PreKeys for both identities.
 * 5. Upload one-time PreKeys via `PUT /v2/keys?identity=aci|pni` and persist AccountCredentials.
 */

import { concatBytes, constantTimeEqual, randomBytes, toBase64 } from '../bytes';
import { aesCtrCrypt, hmacSha256 } from '../crypto/primitives';
import { WebSocketMessage_Type } from '../gen/chat_websocket_pb';
import { ProvisioningAddressSchema, ProvisionMessage, ProvisionMessageSchema } from '../gen/DeviceMessages_pb';
import { DeviceName, DeviceNameSchema } from '../gen/DeviceName_pb';
import { libsignal } from '../protocol/libsignal';
import { generateKyberPreKeys, generateOneTimePreKeys, generateSignedPreKey, ONE_TIME_PRE_KEY_COUNT } from '../protocol/prekeys';
import { create, decodeWebSocketMessage, encodeWebSocketRequest, encodeWebSocketResponse, fromBinary, serviceIdFrom, toBinary } from './proto';
import type { AccountCredentials, KeyPair, SignalProtocolStore } from '../protocol/store';
import { DEFAULT_SIGNAL_SERVER, DEFAULT_SIGNAL_WS, SIGNAL_USER_AGENT, SignalHttpJsonFn } from './http';
import { net, SOCKET_OPEN, SocketLike } from './transport';

/** Signal-Desktop `getCapabilities` for a linked device without a PIN. */
function linkedDeviceCapabilities(hasE164: boolean): Record<string, boolean> {
  return {
    attachmentBackfill: false,
    spqr: true,
    usernameChangeSyncMessage: true,
    optionalPhoneNumber: !hasE164,
  };
}

/** Signal-Desktop `encryptDeviceName`: SIV-style AES-256-CTR under an ECDH secret with our ACI identity key, serialized as a DeviceName proto. */
async function encryptDeviceName(deviceName: string, identityPublic: Uint8Array): Promise<Uint8Array> {
  const plaintext = new TextEncoder().encode(deviceName);
  const ephemeral = libsignal.keyPairGenerate() as { publicKey: Uint8Array; privateKey: Uint8Array };
  const masterSecret = libsignal.calculateAgreement(identityPublic, ephemeral.privateKey);
  const key1 = hmacSha256(masterSecret, new TextEncoder().encode('auth'));
  const syntheticIv = hmacSha256(key1, plaintext).slice(0, 16);
  const key2 = hmacSha256(masterSecret, new TextEncoder().encode('cipher'));
  const cipherKey = hmacSha256(key2, syntheticIv);
  const ciphertext = await aesCtrCrypt(cipherKey, new Uint8Array(16), plaintext);
  return toBinary(DeviceNameSchema, create(DeviceNameSchema, { ephemeralPublic: ephemeral.publicKey, syntheticIv, ciphertext }));
}

export async function decryptDeviceName(encoded: DeviceName, identityPrivate: Uint8Array): Promise<string> {
  const masterSecret = libsignal.calculateAgreement(encoded.ephemeralPublic, identityPrivate);
  const key2 = hmacSha256(masterSecret, new TextEncoder().encode('cipher'));
  const cipherKey = hmacSha256(key2, encoded.syntheticIv);
  const plaintext = await aesCtrCrypt(cipherKey, new Uint8Array(16), encoded.ciphertext);
  const key1 = hmacSha256(masterSecret, new TextEncoder().encode('auth'));
  const expected = hmacSha256(key1, plaintext).slice(0, 16);
  if (!constantTimeEqual(expected, encoded.syntheticIv)) throw new Error('device name failed authentication');
  return new TextDecoder().decode(plaintext);
}

function generatePassword(): string {
  // SECURITY-REVIEW: 18 random bytes from crypto.getRandomValues, same strength as Signal-Desktop's generatePassword
  return toBase64(randomBytes(18)).replace(/=+$/, '');
}

function identityKeyPair(pub?: Uint8Array, priv?: Uint8Array): KeyPair | undefined {
  if (!pub || !priv || priv.length !== 32) return undefined;
  const pubKey = pub.length === 32 ? concatBytes(new Uint8Array([0x05]), pub) : pub;
  if (pubKey.length !== 33) return undefined;
  return { pubKey, privKey: priv };
}

/** The account master key: derived from the Account Entropy Pool when the primary sends one, else the deprecated raw `masterKey` field. */
function provisionedMasterKey(prov: ProvisionMessage): Uint8Array | undefined {
  if (prov.accountEntropyPool) {
    try {
      return libsignal.accountEntropyPoolDeriveMasterKey(prov.accountEntropyPool);
    } catch {
      // fall through to the legacy field
    }
  }
  return prov.masterKey.length === 32 ? prov.masterKey : undefined;
}

export interface ProvisioningCallbacks {
  onQrUrl: (sgnlUri: string) => void;
  onStatus?: (statusText: string) => void;
  /** Runs after the ProvisionMessage is decrypted and before anything is written to the store, so the app can point the store at the linked account's database. */
  beforeLinking?: (account: { aci: string; number: string }) => Promise<void> | void;
  onLinked: (account: AccountCredentials) => void;
  onError: (err: Error) => void;
}

export interface ProvisioningSession {
  cancel: () => void;
}

/** Completes linking once the ProvisionMessage has been decrypted: registers this device and uploads its PreKeys. */
async function finishLinking(
  store: SignalProtocolStore,
  httpRequest: SignalHttpJsonFn,
  prov: ProvisionMessage,
  deviceName: string,
  httpBase = DEFAULT_SIGNAL_SERVER,
  onStatus?: (text: string) => void
): Promise<AccountCredentials> {
  const aci = serviceIdFrom(prov.aci, prov.aciBinary);
  const pniRaw = prov.pni || serviceIdFrom(undefined, prov.pniBinary);
  const pni = pniRaw ? pniRaw.replace(/^PNI:/, '') : undefined;
  const aciIdentity = identityKeyPair(prov.aciIdentityKeyPublic, prov.aciIdentityKeyPrivate);
  const pniIdentity = identityKeyPair(prov.pniIdentityKeyPublic, prov.pniIdentityKeyPrivate);
  if (!aci || !aciIdentity || !prov.provisioningCode) {
    throw new Error('ProvisionMessage missing required identity fields');
  }
  const hasE164 = !!(prov.number && pni && pniIdentity);

  if (onStatus) onStatus('Completing link with Signal\u2026');

  const password = generatePassword();
  const registrationId = libsignal.generateRegistrationId();
  const pniRegistrationId = libsignal.generateRegistrationId();

  // Identity key pairs must be in the account before PreKeys are generated (they sign them).
  const provisional: AccountCredentials = {
    aci,
    pni,
    number: prov.number || '',
    deviceId: 0,
    password,
    registrationId,
    pniRegistrationId,
    aciIdentityKeyPair: aciIdentity,
    pniIdentityKeyPair: pniIdentity,
    profileKey: prov.profileKey.length === 32 ? prov.profileKey : undefined,
    masterKey: provisionedMasterKey(prov),
    accountEntropyPool: prov.accountEntropyPool || undefined,
    userAgent: SIGNAL_USER_AGENT,
  };

  const aciSignedPreKey = await generateSignedPreKey(store, 'aci', aciIdentity);
  const [aciPqLastResortPreKey] = await generateKyberPreKeys(store, 'aci', aciIdentity, 1, true);
  const pniSignedPreKey = hasE164 ? await generateSignedPreKey(store, 'pni', pniIdentity!) : undefined;
  const pniPqLastResortPreKey = hasE164 ? (await generateKyberPreKeys(store, 'pni', pniIdentity!, 1, true))[0] : undefined;

  const encryptedDeviceName = toBase64(await encryptDeviceName(deviceName || 'Signal4KaiOS', aciIdentity.pubKey));

  // SECURITY-REVIEW: Basic auth with the freshly generated device password; neither is logged
  const linkRes = await httpRequest(
    'PUT',
    '/v1/devices/link',
    {
      verificationCode: prov.provisioningCode,
      accountAttributes: {
        fetchesMessages: true,
        name: encryptedDeviceName,
        registrationId,
        pniRegistrationId: hasE164 ? pniRegistrationId : undefined,
        capabilities: linkedDeviceCapabilities(hasE164),
      },
      aciSignedPreKey,
      aciPqLastResortPreKey,
      pniSignedPreKey,
      pniPqLastResortPreKey,
    },
    {
      baseUrl: httpBase,
      basicAuth: { username: aci, password },
      timeout: 30000,
    }
  );

  if (!linkRes || typeof linkRes.deviceId !== 'number' || linkRes.uuid !== aci) {
    throw new Error('Signal server returned an unexpected link response');
  }
  const creds: AccountCredentials = { ...provisional, deviceId: linkRes.deviceId };
  await store.saveAccount(creds);
  await store.saveIdentity(aci, aciIdentity.pubKey, { number: creds.number || undefined, uuid: aci });
  if (pni && pniIdentity) await store.saveIdentity('PNI:' + pni, pniIdentity.pubKey);

  if (onStatus) onStatus('Uploading PreKeys\u2026');
  const auth = { username: `${aci}.${creds.deviceId}`, password };
  await httpRequest(
    'PUT',
    '/v2/keys?identity=aci',
    {
      preKeys: await generateOneTimePreKeys(store, 'aci', ONE_TIME_PRE_KEY_COUNT),
      pqPreKeys: await generateKyberPreKeys(store, 'aci', aciIdentity, ONE_TIME_PRE_KEY_COUNT, false),
    },
    { baseUrl: httpBase, basicAuth: auth, timeout: 30000 }
  );
  if (hasE164) {
    await httpRequest(
      'PUT',
      '/v2/keys?identity=pni',
      {
        preKeys: await generateOneTimePreKeys(store, 'pni', ONE_TIME_PRE_KEY_COUNT),
        pqPreKeys: await generateKyberPreKeys(store, 'pni', pniIdentity!, ONE_TIME_PRE_KEY_COUNT, false),
      },
      { baseUrl: httpBase, basicAuth: auth, timeout: 30000 }
    ).catch(() => {
      // Signal-Desktop also tolerates PNI PreKey upload failures
    });
  }
  return creds;
}

/**
 * Start a live Linked-Device QR provisioning session against Signal servers.
 */
export function startDeviceProvisioning(
  store: SignalProtocolStore,
  httpRequest: SignalHttpJsonFn,
  deviceName: string,
  callbacks: ProvisioningCallbacks,
  serverOptions?: { wsUrl?: string; httpUrl?: string }
): ProvisioningSession {
  const wsBase = (serverOptions?.wsUrl || DEFAULT_SIGNAL_WS).replace(/\/+$/, '');
  const httpBase = (serverOptions?.httpUrl || DEFAULT_SIGNAL_SERVER).replace(/\/+$/, '');
  const receiver = new libsignal.ProvisioningReceiver();
  let closed = false;
  let sock: SocketLike | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  function cleanup() {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (sock) {
      try {
        sock.onclose = null;
        sock.onerror = null;
        sock.onmessage = null;
        sock.close();
      } catch {
        // ignore close errors
      }
      sock = null;
    }
  }

  function finish() {
    closed = true;
    cleanup();
    receiver.free();
  }

  function fail(err: unknown) {
    if (closed) return;
    finish();
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }

  function sendWsAck(id?: bigint) {
    if (!sock || sock.readyState !== SOCKET_OPEN || id === undefined) return;
    sock.send(encodeWebSocketResponse(id, 200, 'OK'));
  }

  try {
    sock = net.openWebSocket(`${wsBase}/v1/websocket/provisioning/?agent=OWD`);

    sock.onopen = () => {
      if (callbacks.onStatus) callbacks.onStatus('Waiting for provisioning QR code\u2026');
      keepaliveTimer = setInterval(() => {
        if (sock && sock.readyState === SOCKET_OPEN) {
          sock.send(encodeWebSocketRequest('GET', '/v1/keepalive', BigInt(Date.now())));
        }
      }, 25000);
    };

    sock.onmessage = (evt: { data: any }) => {
      if (closed) return;
      try {
        const wsMsg = decodeWebSocketMessage(new Uint8Array(evt.data as ArrayBuffer));
        if (wsMsg.type !== WebSocketMessage_Type.REQUEST || !wsMsg.request) return;
        const req = wsMsg.request;
        sendWsAck(req.id);

        if (req.path === '/v1/address' && req.body.length > 0) {
          const uuid = fromBinary(ProvisioningAddressSchema, req.body).address;
          const pubKeyB64 = toBase64(receiver.publicKey());
          callbacks.onQrUrl(`sgnl://linkdevice?uuid=${encodeURIComponent(uuid)}&pub_key=${encodeURIComponent(pubKeyB64)}`);
        } else if (req.path === '/v1/message' && req.body.length > 0) {
          if (callbacks.onStatus) callbacks.onStatus('Decrypting link credentials\u2026');
          const prov = fromBinary(ProvisionMessageSchema, receiver.decryptEnvelope(req.body));
          // The provisioning socket is no longer needed once the ProvisionMessage arrived.
          finish();
          const account = { aci: serviceIdFrom(prov.aci, prov.aciBinary), number: prov.number || '' };
          Promise.resolve()
            .then(() => callbacks.beforeLinking && callbacks.beforeLinking(account))
            .then(() => {
              store.forgetCachedAccount();
              return finishLinking(store, httpRequest, prov, deviceName, httpBase, callbacks.onStatus);
            })
            .then(
              (creds) => callbacks.onLinked(creds),
              (err) => {
                store.forgetCachedAccount();
                callbacks.onError(err instanceof Error ? err : new Error(String(err)));
              }
            );
        }
      } catch (e) {
        fail(e);
      }
    };

    sock.onerror = () => {
      // Handled in onclose
    };

    sock.onclose = (evt) => {
      const detail = evt.code === 1015 && evt.reason ? `: ${evt.reason}` : '';
      fail(new Error(`Provisioning connection closed (code ${evt.code || 1006}${detail}). Check network and try again.`));
    };
  } catch (err) {
    fail(err);
  }

  return {
    cancel: () => {
      if (!closed) finish();
    },
  };
}
