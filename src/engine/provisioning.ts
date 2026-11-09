/* Linked Device QR Provisioning & Initial PreKey Registration.
 *
 * Connects directly to Signal's provisioning WebSocket:
 *   wss://chat.signal.org/v1/websocket/provisioning/?agent=OWD
 *
 * Flow:
 * 1. Generate ephemeral X25519 key pair (ourKeyPair).
 * 2. Receive WebSocketRequestMessage { verb: 'PUT', path: '/v1/address' } -> ProvisioningUuid { uuid }.
 * 3. ACK with 200 OK and emit `sgnl://linkdevice?uuid=<uuid>&pub_key=<encodeURIComponent(base64(pubKey))>` for QR code rendering.
 * 4. When primary device scans QR, receive WebSocketRequestMessage { verb: 'PUT', path: '/v1/message' } -> ProvisionEnvelope.
 * 5. ACK with 200 OK, decrypt ProvisionEnvelope using ProvisioningCipher (ECDH + HKDF("Mixin Provisioning Message") + AES-256-CBC + HMAC-SHA256) -> ProvisionMessage.
 * 6. Confirm device link via PUT /v1/devices/<provisioningCode> (Basic auth with aci:password) -> { deviceId }.
 * 7. Generate and upload SignedPreKey + OneTimePreKeys via PUT /v2/keys.
 * 8. Persist AccountCredentials to SignalProtocolStore.
 */

import {
  concatBytes,
  constantTimeEqual,
  randomBytes,
  toBase64,
} from './bytes';
import {
  calculateAgreement,
  calculateSignature,
  generateKeyPair,
  prependVersionByte,
} from './crypto/curve';
import {
  generateSignedKyberPreKey,
} from './crypto/kem';
import {
  aesCbcDecrypt,
  aesCbcEncrypt,
  hkdfSha256,
  hmacSha256,
} from './crypto/primitives';
import {
  decodeProvisionEnvelope,
  decodeProvisioningUuid,
  decodeProvisionMessage,
  decodeWebSocketMessage,
  encodeProvisionEnvelope,
  encodeProvisionMessage,
  encodeWebSocketMessage,
  ProvisionMessage,
  WebSocketMessageType,
} from './proto';
import type {
  AccountCredentials,
  KeyPair,
  SignedPreKeyRecord,
  SignalProtocolStore,
} from './storage';

const PROVISIONING_INFO = 'Mixin Provisioning Message';
const PROVISIONING_VERSION = 0x01;
const SIGNAL_SERVER_URL = 'https://chat.signal.org';
const SIGNAL_WS_URL = 'wss://chat.signal.org';

/**
 * Decrypt a ProvisionEnvelope received over the provisioning WebSocket using our ephemeral keyPair.
 */
export async function decryptProvisionEnvelope(
  envelopeBytes: Uint8Array,
  ourEphemeralKeyPair: KeyPair
): Promise<ProvisionMessage> {
  const env = decodeProvisionEnvelope(envelopeBytes);
  if (!env.publicKey || !env.body) {
    throw new Error('Malformed ProvisionEnvelope: missing publicKey or body');
  }
  if (env.body.length < 1 + 16 + 16 + 32) {
    throw new Error('ProvisionEnvelope body too short');
  }

  const version = env.body[0];
  if (version !== PROVISIONING_VERSION) {
    throw new Error(`Unsupported ProvisionEnvelope version: ${version}`);
  }

  const iv = env.body.slice(1, 17);
  const mac = env.body.slice(env.body.length - 32);
  const ciphertext = env.body.slice(17, env.body.length - 32);
  const versionAndIvAndCiphertext = env.body.slice(0, env.body.length - 32);

  const sharedSecret = calculateAgreement(env.publicKey, ourEphemeralKeyPair.privKey);
  const derived = hkdfSha256(sharedSecret, PROVISIONING_INFO, 64);
  const aesKey = derived.slice(0, 32);
  const macKey = derived.slice(32, 64);

  const expectedMac = hmacSha256(macKey, versionAndIvAndCiphertext);
  if (!constantTimeEqual(mac, expectedMac)) {
    throw new Error('ProvisionEnvelope HMAC verification failed');
  }

  const plaintext = await aesCbcDecrypt(aesKey, iv, ciphertext);
  return decodeProvisionMessage(plaintext);
}

/**
 * Encrypt a ProvisionMessage into a ProvisionEnvelope (used in tests and device-to-device simulation).
 */
export async function encryptProvisionEnvelope(
  msg: ProvisionMessage,
  theirEphemeralPublicKey: Uint8Array,
  ourEphemeralKeyPair = generateKeyPair()
): Promise<Uint8Array> {
  const plaintext = encodeProvisionMessage(msg);
  const sharedSecret = calculateAgreement(theirEphemeralPublicKey, ourEphemeralKeyPair.privKey);
  const derived = hkdfSha256(sharedSecret, PROVISIONING_INFO, 64);
  const aesKey = derived.slice(0, 32);
  const macKey = derived.slice(32, 64);

  const iv = randomBytes(16);
  const ciphertext = await aesCbcEncrypt(aesKey, iv, plaintext);
  const versionAndIvAndCiphertext = concatBytes(
    new Uint8Array([PROVISIONING_VERSION]),
    iv,
    ciphertext
  );
  const mac = hmacSha256(macKey, versionAndIvAndCiphertext);

  return encodeProvisionEnvelope({
    publicKey: prependVersionByte(ourEphemeralKeyPair.pubKey),
    body: concatBytes(versionAndIvAndCiphertext, mac),
  });
}

function generateRegistrationId(): number {
  const b = randomBytes(2);
  return (((b[0] << 8) | b[1]) & 0x3fff) + 1;
}

function generatePassword(): string {
  return toBase64(randomBytes(18));
}

export interface PreKeyUploadBundle {
  identityKey: string;
  signedPreKey: {
    keyId: number;
    publicKey: string;
    signature: string;
  };
  preKeys: Array<{
    keyId: number;
    publicKey: string;
  }>;
  pqLastResortPreKey?: {
    keyId: number;
    publicKey: string;
    signature: string;
  };
  pqPreKeys?: Array<{
    keyId: number;
    publicKey: string;
    signature: string;
  }>;
}

/**
 * Generate a fresh SignedPreKey, a batch of OneTimePreKeys, a Last-Resort Kyber-1024 PreKey,
 * and a batch of one-time Kyber-1024 PreKeys, storing them in `store` and returning the JSON payload for `PUT /v2/keys`.
 */
export async function generateAndStorePreKeyBundle(
  store: SignalProtocolStore,
  identityKeyPair: KeyPair,
  signedKeyId = 1,
  startPreKeyId = 1,
  count = 50,
  kyberCount = 10
): Promise<PreKeyUploadBundle> {
  const spkPair = generateKeyPair();
  const spkPub = prependVersionByte(spkPair.pubKey);
  const signature = calculateSignature(identityKeyPair.privKey, spkPub);

  const signedRecord: SignedPreKeyRecord = {
    keyId: signedKeyId,
    keyPair: spkPair,
    signature,
    timestamp: Date.now(),
  };
  await store.storeSignedPreKey(signedRecord);

  const preKeys: Array<{ keyId: number; publicKey: string }> = [];
  for (let i = 0; i < count; i++) {
    const keyId = startPreKeyId + i;
    const kp = generateKeyPair();
    await store.storePreKey(keyId, kp);
    preKeys.push({
      keyId,
      publicKey: toBase64(prependVersionByte(kp.pubKey)),
    });
  }

  // Generate Kyber-1024 Last-Resort PreKey + one-time Kyber PreKeys
  const lastResortKyber = generateSignedKyberPreKey(
    identityKeyPair.privKey,
    signedKeyId,
    true
  );
  await store.storeKyberPreKey(lastResortKyber);

  const pqPreKeys: Array<{ keyId: number; publicKey: string; signature: string }> = [];
  for (let i = 0; i < kyberCount; i++) {
    const kId = startPreKeyId + i;
    const kRec = generateSignedKyberPreKey(identityKeyPair.privKey, kId, false);
    await store.storeKyberPreKey(kRec);
    pqPreKeys.push({
      keyId: kId,
      publicKey: toBase64(kRec.keyPair.pubKey),
      signature: toBase64(kRec.signature),
    });
  }

  return {
    identityKey: toBase64(prependVersionByte(identityKeyPair.pubKey)),
    signedPreKey: {
      keyId: signedKeyId,
      publicKey: toBase64(spkPub),
      signature: toBase64(signature),
    },
    preKeys,
    pqLastResortPreKey: {
      keyId: lastResortKyber.keyId,
      publicKey: toBase64(lastResortKyber.keyPair.pubKey),
      signature: toBase64(lastResortKyber.signature),
    },
    pqPreKeys,
  };
}

export interface ProvisioningCallbacks {
  onQrUrl: (sgnlUri: string) => void;
  onStatus?: (statusText: string) => void;
  onLinked: (account: AccountCredentials) => void;
  onError: (err: Error) => void;
}

export interface ProvisioningSession {
  cancel: () => void;
}

export type SignalHttpJsonFn = (
  method: string,
  path: string,
  body: unknown,
  opts?: {
    baseUrl?: string;
    noAuth?: boolean;
    basicAuth?: { username: string; password: string };
    headers?: Record<string, string>;
    timeout?: number;
  }
) => Promise<any>;

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
  const wsBase = (serverOptions?.wsUrl || SIGNAL_WS_URL).replace(/\/+$/, '');
  const httpBase = (serverOptions?.httpUrl || SIGNAL_SERVER_URL).replace(/\/+$/, '');
  const ephemeralKeyPair = generateKeyPair();
  let closed = false;
  let sock: WebSocket | null = null;
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

  function sendWsAck(id?: bigint) {
    if (!sock || sock.readyState !== WebSocket.OPEN || id === undefined) return;
    const resp = encodeWebSocketMessage({
      type: WebSocketMessageType.RESPONSE,
      response: {
        id,
        status: 200,
        message: 'OK',
        headers: [],
      },
    });
    sock.send(resp);
  }

  async function finalizeProvisioning(prov: ProvisionMessage) {
    if (
      !prov.aciIdentityKeyPublic ||
      !prov.aciIdentityKeyPrivate ||
      !prov.provisioningCode ||
      (!prov.aci && !prov.number)
    ) {
      throw new Error('ProvisionMessage missing required identity fields');
    }

    if (callbacks.onStatus) callbacks.onStatus('Completing link with Signal\u2026');

    const aci = prov.aci || prov.number!;
    const number = prov.number || prov.aci!;
    const password = generatePassword();
    const registrationId = generateRegistrationId();
    const pniRegistrationId = generateRegistrationId();
    const signalingKey = toBase64(randomBytes(52));

    const aciIdentityKeyPair: KeyPair = {
      pubKey: prependVersionByte(prov.aciIdentityKeyPublic),
      privKey: prov.aciIdentityKeyPrivate,
    };
    const pniIdentityKeyPair: KeyPair | undefined =
      prov.pniIdentityKeyPublic && prov.pniIdentityKeyPrivate
        ? {
            pubKey: prependVersionByte(prov.pniIdentityKeyPublic),
            privKey: prov.pniIdentityKeyPrivate,
          }
        : undefined;

    // Confirm linked device registration on Signal server: PUT /v1/devices/{provisioningCode}
    const verifyRes = await httpRequest(
      'PUT',
      `/v1/devices/${encodeURIComponent(prov.provisioningCode)}`,
      {
        signalingKey,
        fetchesMessages: true,
        registrationId,
        pniRegistrationId,
        name: deviceName || 'Signal4KaiOS',
        capabilities: {
          gv2: true,
          storage: false,
          'gv1-migration': true,
          senderKey: true,
          announcementGroup: true,
          changeNumber: true,
          stories: false,
          pni: true,
        },
      },
      {
        baseUrl: httpBase,
        basicAuth: { username: aci, password },
        timeout: 20000,
      }
    );

    const deviceId = (verifyRes && typeof verifyRes.deviceId === 'number') ? verifyRes.deviceId : 2;
    const authUser = `${aci}.${deviceId}`;

    if (callbacks.onStatus) callbacks.onStatus('Generating & uploading PreKeys\u2026');

    const keyBundle = await generateAndStorePreKeyBundle(
      store,
      aciIdentityKeyPair,
      1,
      1,
      50,
      10
    );

    await httpRequest('PUT', '/v2/keys?identity=aci', keyBundle, {
      baseUrl: httpBase,
      basicAuth: { username: authUser, password },
      timeout: 25000,
    });

    if (pniIdentityKeyPair) {
      const pniBundle = await generateAndStorePreKeyBundle(
        store,
        pniIdentityKeyPair,
        1000,
        1000,
        25,
        5
      );
      await httpRequest('PUT', '/v2/keys?identity=pni', pniBundle, {
        baseUrl: httpBase,
        basicAuth: { username: authUser, password },
        timeout: 25000,
      }).catch(() => {});
    }

    const creds: AccountCredentials = {
      aci,
      pni: prov.pni,
      number,
      deviceId,
      password,
      registrationId,
      pniRegistrationId,
      aciIdentityKeyPair,
      pniIdentityKeyPair,
      profileKey: prov.profileKey,
      masterKey: prov.masterKey,
      userAgent: 'Signal4KaiOS/2.0.0',
    };

    await store.saveAccount(creds);
    await store.saveIdentity(aci, aciIdentityKeyPair.pubKey, {
      number,
      uuid: aci,
    });

    if (!closed) {
      cleanup();
      callbacks.onLinked(creds);
    }
  }

  try {
    const url = `${wsBase}/v1/websocket/provisioning/?agent=OWD`;
    sock = new WebSocket(url);
    sock.binaryType = 'arraybuffer';

    sock.onopen = () => {
      if (callbacks.onStatus) callbacks.onStatus('Waiting for provisioning QR code\u2026');
      keepaliveTimer = setInterval(() => {
        if (sock && sock.readyState === WebSocket.OPEN) {
          const ka = encodeWebSocketMessage({
            type: WebSocketMessageType.REQUEST,
            request: {
              verb: 'GET',
              path: '/v1/keepalive/provisioning',
              id: BigInt(Date.now()),
              headers: [],
            },
          });
          sock.send(ka);
        }
      }, 25000);
    };

    sock.onmessage = (evt: MessageEvent) => {
      if (closed) return;
      try {
        const bytes = new Uint8Array(evt.data as ArrayBuffer);
        const wsMsg = decodeWebSocketMessage(bytes);
        if (wsMsg.type !== WebSocketMessageType.REQUEST || !wsMsg.request) return;

        const req = wsMsg.request;
        sendWsAck(req.id);

        if (req.path === '/v1/address' && req.body) {
          const { uuid } = decodeProvisioningUuid(req.body);
          const pubKeyB64 = toBase64(prependVersionByte(ephemeralKeyPair.pubKey));
          const sgnlUri =
            `sgnl://linkdevice?uuid=${encodeURIComponent(uuid)}` +
            `&pub_key=${encodeURIComponent(pubKeyB64)}`;
          callbacks.onQrUrl(sgnlUri);
        } else if (req.path === '/v1/message' && req.body) {
          if (callbacks.onStatus) callbacks.onStatus('Decrypting link credentials\u2026');
          decryptProvisionEnvelope(req.body, ephemeralKeyPair)
            .then((prov) => finalizeProvisioning(prov))
            .catch((err) => {
              if (!closed) {
                cleanup();
                callbacks.onError(err instanceof Error ? err : new Error(String(err)));
              }
            });
        }
      } catch (e) {
        if (!closed) {
          callbacks.onError(e instanceof Error ? e : new Error(String(e)));
        }
      }
    };

    sock.onerror = () => {
      // Handled in onclose
    };

    sock.onclose = (evt: CloseEvent) => {
      if (closed) return;
      cleanup();
      callbacks.onError(
        new Error(
          `Provisioning connection closed (code ${evt.code || 1006}). Check network and try again.`
        )
      );
    };
  } catch (err) {
    cleanup();
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }

  return {
    cancel: () => {
      closed = true;
      cleanup();
    },
  };
}
