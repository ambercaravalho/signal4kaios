/* Signal Protocol v3 X3DH + Double Ratchet Session implementation.
 * Supports initiating sessions from a PreKeyBundle, responding to PreKeySignalMessage,
 * encrypting/decrypting SignalMessage frames, and handling out-of-order skipped keys.
 */

import { concatBytes, constantTimeEqual } from '../bytes';
import {
  calculateAgreement,
  generateKeyPair,
  prependVersionByte,
  verifySignature,
} from '../crypto/curve';
import {
  kyberDecapsulate,
  kyberEncapsulate,
  verifyKyberPreKeySignature,
} from '../crypto/kem';
import {
  aesCbcDecrypt,
  aesCbcEncrypt,
  hkdfSha256,
  hmacSha256,
} from '../crypto/primitives';
import {
  decodePreKeySignalMessageProto,
  decodeSignalMessageProto,
  encodePreKeySignalMessageProto,
  encodeSignalMessageProto,
} from '../proto';
import type {
  ChainState,
  KeyPair,
  RatchetSessionState,
  SignalProtocolStore,
} from '../storage';

const VERSION_BYTE = 0x33; // (3 << 4) | 3
const MAC_LENGTH = 8;
const MAX_RECEIVING_CHAINS = 5;
const MAX_SKIPPED_MESSAGE_KEYS = 2000;

const WHISPER_TEXT_INFO = 'WhisperText';
const WHISPER_TEXT_PQ_INFO = 'WhisperText_X25519_SHA-256_CRYSTALS-KYBER-1024';
const WHISPER_RATCHET_INFO = 'WhisperRatchet';
const WHISPER_MESSAGE_KEYS_INFO = 'WhisperMessageKeys';

const MESSAGE_KEY_SEED = new Uint8Array([0x01]);
const CHAIN_KEY_SEED = new Uint8Array([0x02]);

export interface RemotePreKeyBundle {
  registrationId: number;
  deviceId: number;
  preKeyId?: number;
  preKeyPublic?: Uint8Array;
  signedPreKeyId: number;
  signedPreKeyPublic: Uint8Array;
  signedPreKeySignature: Uint8Array;
  kyberPreKeyId?: number;
  kyberPreKeyPublic?: Uint8Array;
  kyberPreKeySignature?: Uint8Array;
  identityKey: Uint8Array;
}

export interface EncryptedWhisperMessage {
  type: 1 | 3; // 1 = WHISPER_MESSAGE (Ciphertext), 3 = PREKEY_BUNDLE
  body: Uint8Array;
  registrationId: number;
}

function deriveMessageKeys(chainKey: Uint8Array): {
  cipherKey: Uint8Array;
  macKey: Uint8Array;
  iv: Uint8Array;
  raw80: Uint8Array;
} {
  const msgKeyInput = hmacSha256(chainKey, MESSAGE_KEY_SEED);
  const raw80 = hkdfSha256(msgKeyInput, WHISPER_MESSAGE_KEYS_INFO, 80);
  return {
    cipherKey: raw80.slice(0, 32),
    macKey: raw80.slice(32, 64),
    iv: raw80.slice(64, 80),
    raw80,
  };
}

function unpackMessageKeys(raw80: Uint8Array): {
  cipherKey: Uint8Array;
  macKey: Uint8Array;
  iv: Uint8Array;
} {
  return {
    cipherKey: raw80.slice(0, 32),
    macKey: raw80.slice(32, 64),
    iv: raw80.slice(64, 80),
  };
}

function advanceChainKey(chainKey: Uint8Array): Uint8Array {
  return hmacSha256(chainKey, CHAIN_KEY_SEED);
}

function deriveRootAndChainKey(
  rootKey: Uint8Array,
  dhPublicKey: Uint8Array,
  dhPrivateKey: Uint8Array
): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const sharedSecret = calculateAgreement(dhPublicKey, dhPrivateKey);
  const derived = hkdfSha256(sharedSecret, WHISPER_RATCHET_INFO, 64, rootKey);
  return {
    rootKey: derived.slice(0, 32),
    chainKey: derived.slice(32, 64),
  };
}

function computeSignalMessageMac(
  senderIdentityPublic: Uint8Array,
  receiverIdentityPublic: Uint8Array,
  macKey: Uint8Array,
  versionAndProtoBytes: Uint8Array
): Uint8Array {
  const macInput = concatBytes(
    prependVersionByte(senderIdentityPublic),
    prependVersionByte(receiverIdentityPublic),
    versionAndProtoBytes
  );
  return hmacSha256(macKey, macInput).slice(0, MAC_LENGTH);
}

/**
 * Initialize an outbound X3DH + Double Ratchet session from a recipient's PreKeyBundle.
 */
export async function initSessionFromPreKeyBundle(
  store: SignalProtocolStore,
  recipientAddress: string,
  bundle: RemotePreKeyBundle
): Promise<RatchetSessionState> {
  const remoteIdentity = prependVersionByte(bundle.identityKey);
  const remoteSignedPreKey = prependVersionByte(bundle.signedPreKeyPublic);

  if (!verifySignature(remoteIdentity, remoteSignedPreKey, bundle.signedPreKeySignature)) {
    throw new Error('Invalid signature on remote SignedPreKey');
  }

  await store.saveIdentity(recipientAddress.split('.')[0], remoteIdentity);

  const ourIdentity = await store.getIdentityKeyPair();
  const localRegistrationId = await store.getLocalRegistrationId();
  const ourBaseKey = generateKeyPair();
  const ourSendingRatchetKey = generateKeyPair();

  // X3DH / PQXDH master secret = 0xFF*32 || DH(IKa, SPKb) || DH(EKa, IKb) || DH(EKa, SPKb) [|| DH(EKa, OPKb)] [|| KEM_SS]
  const discontinuity = new Uint8Array(32).fill(0xff);
  const dh1 = calculateAgreement(remoteSignedPreKey, ourIdentity.privKey);
  const dh2 = calculateAgreement(remoteIdentity, ourBaseKey.privKey);
  const dh3 = calculateAgreement(remoteSignedPreKey, ourBaseKey.privKey);

  const parts = [discontinuity, dh1, dh2, dh3];
  if (bundle.preKeyPublic && bundle.preKeyId !== undefined) {
    const remoteOneTimePreKey = prependVersionByte(bundle.preKeyPublic);
    parts.push(calculateAgreement(remoteOneTimePreKey, ourBaseKey.privKey));
  }

  let kyberPreKeyId: number | undefined;
  let kyberCiphertext: Uint8Array | undefined;
  let hkdfInfo = WHISPER_TEXT_INFO;

  if (
    bundle.kyberPreKeyPublic &&
    bundle.kyberPreKeySignature &&
    bundle.kyberPreKeyId !== undefined
  ) {
    if (
      !verifyKyberPreKeySignature(
        remoteIdentity,
        bundle.kyberPreKeyPublic,
        bundle.kyberPreKeySignature
      )
    ) {
      throw new Error('Invalid signature on remote KyberPreKey');
    }
    const kem = kyberEncapsulate(bundle.kyberPreKeyPublic);
    parts.push(kem.sharedSecret);
    kyberPreKeyId = bundle.kyberPreKeyId;
    kyberCiphertext = kem.ciphertext;
    hkdfInfo = WHISPER_TEXT_PQ_INFO;
  }

  const masterKey = hkdfSha256(concatBytes(...parts), hkdfInfo, 64);
  const initialRootKey = masterKey.slice(0, 32);
  const initialRecvChainKey = masterKey.slice(32, 64);

  // Step sending ratchet against remoteSignedPreKey
  const sendingRatchet = deriveRootAndChainKey(
    initialRootKey,
    remoteSignedPreKey,
    ourSendingRatchetKey.privKey
  );

  const session: RatchetSessionState = {
    sessionVersion: kyberPreKeyId !== undefined ? 4 : 3,
    localIdentityPublic: prependVersionByte(ourIdentity.pubKey),
    remoteIdentityPublic: remoteIdentity,
    rootKey: sendingRatchet.rootKey,
    sendingChain: {
      ratchetKeyPair: ourSendingRatchetKey,
      chain: { chainKey: sendingRatchet.chainKey, counter: 0 },
    },
    receivingChains: [
      {
        remoteRatchetKey: remoteSignedPreKey,
        chain: { chainKey: initialRecvChainKey, counter: 0 },
        messageKeys: {},
      },
    ],
    previousCounter: 0,
    remoteRegistrationId: bundle.registrationId,
    localRegistrationId,
    pendingPreKey: {
      preKeyId: bundle.preKeyId,
      signedPreKeyId: bundle.signedPreKeyId,
      kyberPreKeyId,
      kyberCiphertext,
      baseKey: ourBaseKey.pubKey,
    },
  };

  await store.storeSession(recipientAddress, session);
  return session;
}

/**
 * Initialize an inbound X3DH / PQXDH session when receiving a PreKeySignalMessage.
 */
async function initSessionFromPreKeyWhisperMessage(
  store: SignalProtocolStore,
  senderAddress: string,
  preKeyMsg: ReturnType<typeof decodePreKeySignalMessageProto>
): Promise<{
  session: RatchetSessionState;
  consumedPreKeyId?: number;
  consumedKyberPreKeyId?: number;
}> {
  if (
    !preKeyMsg.identityKey ||
    !preKeyMsg.baseKey ||
    preKeyMsg.signedPreKeyId === undefined
  ) {
    throw new Error('Incomplete PreKeySignalMessage');
  }

  const remoteIdentity = prependVersionByte(preKeyMsg.identityKey);
  const remoteBaseKey = prependVersionByte(preKeyMsg.baseKey);

  await store.saveIdentity(senderAddress.split('.')[0], remoteIdentity);

  const ourIdentity = await store.getIdentityKeyPair();
  const localRegistrationId = await store.getLocalRegistrationId();

  const ourSignedPreKey = await store.loadSignedPreKey(preKeyMsg.signedPreKeyId);
  if (!ourSignedPreKey) {
    throw new Error(`Missing local SignedPreKey id=${preKeyMsg.signedPreKeyId}`);
  }

  let ourOneTimePreKey: KeyPair | null = null;
  if (preKeyMsg.preKeyId !== undefined) {
    ourOneTimePreKey = await store.loadPreKey(preKeyMsg.preKeyId);
    if (!ourOneTimePreKey) {
      throw new Error(`Missing local OneTimePreKey id=${preKeyMsg.preKeyId}`);
    }
  }

  // Responder X3DH / PQXDH: DH(SPKb, IKa) || DH(IKb, EKa) || DH(SPKb, EKa) [|| DH(OPKb, EKa)] [|| KEM_SS]
  const discontinuity = new Uint8Array(32).fill(0xff);
  const dh1 = calculateAgreement(remoteIdentity, ourSignedPreKey.keyPair.privKey);
  const dh2 = calculateAgreement(remoteBaseKey, ourIdentity.privKey);
  const dh3 = calculateAgreement(remoteBaseKey, ourSignedPreKey.keyPair.privKey);

  const parts = [discontinuity, dh1, dh2, dh3];
  if (ourOneTimePreKey) {
    parts.push(calculateAgreement(remoteBaseKey, ourOneTimePreKey.privKey));
  }

  let consumedKyberPreKeyId: number | undefined;
  let hkdfInfo = WHISPER_TEXT_INFO;
  if (preKeyMsg.kyberPreKeyId !== undefined && preKeyMsg.kyberCiphertext) {
    const ourKyberPreKey = await store.loadKyberPreKey(preKeyMsg.kyberPreKeyId);
    if (!ourKyberPreKey) {
      throw new Error(`Missing local KyberPreKey id=${preKeyMsg.kyberPreKeyId}`);
    }
    const kemSecret = kyberDecapsulate(
      preKeyMsg.kyberCiphertext,
      ourKyberPreKey.keyPair.privKey
    );
    parts.push(kemSecret);
    consumedKyberPreKeyId = preKeyMsg.kyberPreKeyId;
    hkdfInfo = WHISPER_TEXT_PQ_INFO;
  }

  const masterKey = hkdfSha256(concatBytes(...parts), hkdfInfo, 64);
  const initialRootKey = masterKey.slice(0, 32);
  const initialSendChainKey = masterKey.slice(32, 64);

  const session: RatchetSessionState = {
    sessionVersion: consumedKyberPreKeyId !== undefined ? 4 : 3,
    localIdentityPublic: prependVersionByte(ourIdentity.pubKey),
    remoteIdentityPublic: remoteIdentity,
    rootKey: initialRootKey,
    sendingChain: {
      ratchetKeyPair: ourSignedPreKey.keyPair,
      chain: { chainKey: initialSendChainKey, counter: 0 },
    },
    receivingChains: [],
    previousCounter: 0,
    remoteRegistrationId: preKeyMsg.registrationId || 0,
    localRegistrationId,
  };

  return {
    session,
    consumedPreKeyId: ourOneTimePreKey ? preKeyMsg.preKeyId : undefined,
    consumedKyberPreKeyId,
  };
}

function findReceivingChain(
  session: RatchetSessionState,
  remoteRatchetKey: Uint8Array
) {
  return session.receivingChains.find((rc) =>
    constantTimeEqual(rc.remoteRatchetKey, remoteRatchetKey)
  );
}

function getOrCreateReceivingChain(
  session: RatchetSessionState,
  remoteRatchetKey: Uint8Array
): {
  remoteRatchetKey: Uint8Array;
  chain: ChainState;
  messageKeys: Record<number, Uint8Array>;
} {
  const existing = findReceivingChain(session, remoteRatchetKey);
  if (existing) return existing;

  if (!session.sendingChain) {
    throw new Error('Session missing sendingChain during DH ratchet step');
  }

  // DH ratchet step for receiving chain
  const recvRatchet = deriveRootAndChainKey(
    session.rootKey,
    remoteRatchetKey,
    session.sendingChain.ratchetKeyPair.privKey
  );

  // DH ratchet step for new sending chain
  const newSendingRatchetKey = generateKeyPair();
  const sendRatchet = deriveRootAndChainKey(
    recvRatchet.rootKey,
    remoteRatchetKey,
    newSendingRatchetKey.privKey
  );

  session.previousCounter = session.sendingChain.chain.counter;
  session.rootKey = sendRatchet.rootKey;
  session.sendingChain = {
    ratchetKeyPair: newSendingRatchetKey,
    chain: { chainKey: sendRatchet.chainKey, counter: 0 },
  };

  const newRecvChain = {
    remoteRatchetKey,
    chain: { chainKey: recvRatchet.chainKey, counter: 0 },
    messageKeys: {} as Record<number, Uint8Array>,
  };

  session.receivingChains.push(newRecvChain);
  while (session.receivingChains.length > MAX_RECEIVING_CHAINS) {
    session.receivingChains.shift();
  }

  return newRecvChain;
}

function deriveKeysForCounter(
  recvChain: {
    remoteRatchetKey: Uint8Array;
    chain: ChainState;
    messageKeys: Record<number, Uint8Array>;
  },
  counter: number
): { cipherKey: Uint8Array; macKey: Uint8Array; iv: Uint8Array } {
  if (recvChain.chain.counter > counter) {
    const cached = recvChain.messageKeys[counter];
    if (!cached) {
      throw new Error(`Duplicate or expired message counter ${counter}`);
    }
    delete recvChain.messageKeys[counter];
    return unpackMessageKeys(cached);
  }

  if (counter - recvChain.chain.counter > MAX_SKIPPED_MESSAGE_KEYS) {
    throw new Error('Over 2000 messages skipped into the future');
  }

  while (recvChain.chain.counter < counter) {
    const derived = deriveMessageKeys(recvChain.chain.chainKey);
    recvChain.messageKeys[recvChain.chain.counter] = derived.raw80;
    recvChain.chain.chainKey = advanceChainKey(recvChain.chain.chainKey);
    recvChain.chain.counter += 1;
  }

  const finalKeys = deriveMessageKeys(recvChain.chain.chainKey);
  recvChain.chain.chainKey = advanceChainKey(recvChain.chain.chainKey);
  recvChain.chain.counter += 1;

  return {
    cipherKey: finalKeys.cipherKey,
    macKey: finalKeys.macKey,
    iv: finalKeys.iv,
  };
}

/**
 * Encrypt a plaintext payload for a remote Signal device `<aci>.<deviceId>`.
 */
export async function encryptWhisperMessage(
  store: SignalProtocolStore,
  recipientAddress: string,
  plaintext: Uint8Array
): Promise<EncryptedWhisperMessage> {
  const session = await store.loadSession(recipientAddress);
  if (!session || !session.sendingChain) {
    throw new Error(`No active session for ${recipientAddress}`);
  }

  const { cipherKey, macKey, iv } = deriveMessageKeys(session.sendingChain.chain.chainKey);
  const counter = session.sendingChain.chain.counter;

  const ciphertext = await aesCbcEncrypt(cipherKey, iv, plaintext);

  const signalMsgProto = encodeSignalMessageProto({
    ratchetKey: prependVersionByte(session.sendingChain.ratchetKeyPair.pubKey),
    counter,
    previousCounter: session.previousCounter,
    ciphertext,
  });

  const versionAndProto = concatBytes(new Uint8Array([VERSION_BYTE]), signalMsgProto);
  const mac = computeSignalMessageMac(
    session.localIdentityPublic,
    session.remoteIdentityPublic,
    macKey,
    versionAndProto
  );
  const whisperBytes = concatBytes(versionAndProto, mac);

  // Advance sending chain
  session.sendingChain.chain.chainKey = advanceChainKey(session.sendingChain.chain.chainKey);
  session.sendingChain.chain.counter += 1;
  await store.storeSession(recipientAddress, session);

  if (session.pendingPreKey) {
    const preKeyProto = encodePreKeySignalMessageProto({
      registrationId: session.localRegistrationId,
      preKeyId: session.pendingPreKey.preKeyId,
      signedPreKeyId: session.pendingPreKey.signedPreKeyId,
      kyberPreKeyId: session.pendingPreKey.kyberPreKeyId,
      kyberCiphertext: session.pendingPreKey.kyberCiphertext,
      baseKey: prependVersionByte(session.pendingPreKey.baseKey),
      identityKey: prependVersionByte(session.localIdentityPublic),
      message: whisperBytes,
    });
    const fullPreKeyBytes = concatBytes(new Uint8Array([VERSION_BYTE]), preKeyProto);
    return {
      type: 3,
      body: fullPreKeyBytes,
      registrationId: session.remoteRegistrationId,
    };
  }

  return {
    type: 1,
    body: whisperBytes,
    registrationId: session.remoteRegistrationId,
  };
}

/**
 * Decrypt a raw SignalMessage (type 1) against a given session state (mutates session in place).
 */
async function decryptSignalMessageWithSession(
  session: RatchetSessionState,
  whisperBytes: Uint8Array
): Promise<Uint8Array> {
  if (whisperBytes.length < 1 + MAC_LENGTH) {
    throw new Error('WhisperMessage too short');
  }
  const version = whisperBytes[0] >>> 4;
  if (version !== 3) {
    throw new Error(`Unsupported SignalMessage version ${version}`);
  }

  const versionAndProto = whisperBytes.slice(0, whisperBytes.length - MAC_LENGTH);
  const theirMac = whisperBytes.slice(whisperBytes.length - MAC_LENGTH);
  const protoBytes = versionAndProto.slice(1);

  const decoded = decodeSignalMessageProto(protoBytes);
  if (!decoded.ratchetKey || decoded.counter === undefined || !decoded.ciphertext) {
    throw new Error('Malformed SignalMessage protobuf');
  }

  const remoteRatchetKey = prependVersionByte(decoded.ratchetKey);
  const recvChain = getOrCreateReceivingChain(session, remoteRatchetKey);
  const { cipherKey, macKey, iv } = deriveKeysForCounter(recvChain, decoded.counter);

  const expectedMac = computeSignalMessageMac(
    session.remoteIdentityPublic,
    session.localIdentityPublic,
    macKey,
    versionAndProto
  );
  if (!constantTimeEqual(theirMac, expectedMac)) {
    throw new Error('Bad MAC on SignalMessage');
  }

  const plaintext = await aesCbcDecrypt(cipherKey, iv, decoded.ciphertext);
  // Once we successfully receive a reply on this session, clear pendingPreKey
  delete session.pendingPreKey;
  return plaintext;
}

/**
 * Decrypt an incoming PreKeySignalMessage (type 3).
 */
export async function decryptPreKeyWhisperMessage(
  store: SignalProtocolStore,
  senderAddress: string,
  preKeyWhisperBytes: Uint8Array
): Promise<Uint8Array> {
  if (preKeyWhisperBytes.length < 2) {
    throw new Error('PreKeySignalMessage too short');
  }
  const version = preKeyWhisperBytes[0] >>> 4;
  if (version !== 3) {
    throw new Error(`Unsupported PreKeySignalMessage version ${version}`);
  }

  const preKeyMsg = decodePreKeySignalMessageProto(preKeyWhisperBytes.slice(1));
  if (!preKeyMsg.message) {
    throw new Error('PreKeySignalMessage missing inner SignalMessage');
  }

  const { session, consumedPreKeyId, consumedKyberPreKeyId } =
    await initSessionFromPreKeyWhisperMessage(store, senderAddress, preKeyMsg);

  const plaintext = await decryptSignalMessageWithSession(session, preKeyMsg.message);
  await store.storeSession(senderAddress, session);
  if (consumedPreKeyId !== undefined) {
    await store.removePreKey(consumedPreKeyId);
  }
  if (consumedKyberPreKeyId !== undefined) {
    await store.removeKyberPreKey(consumedKyberPreKeyId);
  }
  return plaintext;
}

/**
 * Decrypt an incoming standard SignalMessage (type 1).
 */
export async function decryptWhisperMessage(
  store: SignalProtocolStore,
  senderAddress: string,
  whisperBytes: Uint8Array
): Promise<Uint8Array> {
  const session = await store.loadSession(senderAddress);
  if (!session) {
    throw new Error(`No session found for ${senderAddress}`);
  }
  const plaintext = await decryptSignalMessageWithSession(session, whisperBytes);
  await store.storeSession(senderAddress, session);
  return plaintext;
}
