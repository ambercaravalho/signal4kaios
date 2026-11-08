/* Group Sender Keys (SenderKeyDistributionMessage & SenderKeyMessage) implementation.
 * Supports establishing group sender chains and encrypting/decrypting SenderKey ciphertexts.
 */

import { concatBytes, randomBytes } from '../bytes';
import {
  calculateSignature,
  generateKeyPair,
  prependVersionByte,
  verifySignature,
} from '../crypto/curve';
import {
  aesCbcDecrypt,
  aesCbcEncrypt,
  hkdfSha256,
  hmacSha256,
} from '../crypto/primitives';
import {
  decodeSenderKeyDistributionProto,
  decodeSenderKeyMessageProto,
  encodeSenderKeyDistributionProto,
  encodeSenderKeyMessageProto,
} from '../proto';
import type { SenderKeyState, SignalProtocolStore } from '../storage';

const SENDERKEY_VERSION_BYTE = 0x33;
const SIGNATURE_LENGTH = 64;
const WHISPER_GROUP_INFO = 'WhisperGroup';
const MESSAGE_KEY_SEED = new Uint8Array([0x01]);
const CHAIN_KEY_SEED = new Uint8Array([0x02]);
const MAX_SKIPPED_SENDER_KEYS = 2000;

function deriveSenderMessageKey(chainKey: Uint8Array): {
  iv: Uint8Array;
  cipherKey: Uint8Array;
  seed: Uint8Array;
} {
  const seed = hmacSha256(chainKey, MESSAGE_KEY_SEED);
  const derived = hkdfSha256(seed, WHISPER_GROUP_INFO, 48);
  return {
    iv: derived.slice(0, 16),
    cipherKey: derived.slice(16, 48),
    seed,
  };
}

function advanceSenderChainKey(chainKey: Uint8Array): Uint8Array {
  return hmacSha256(chainKey, CHAIN_KEY_SEED);
}

/**
 * Create or load our own SenderKeyDistributionMessage for a given group/distribution ID.
 */
export async function createSenderKeyDistributionMessage(
  store: SignalProtocolStore,
  senderKeyName: string
): Promise<Uint8Array> {
  let state = await store.loadSenderKey(senderKeyName);
  if (!state || !state.signingKeyPrivate) {
    const signingKey = generateKeyPair();
    const keyId =
      ((randomBytes(4)[0] << 24) |
        (randomBytes(4)[1] << 16) |
        (randomBytes(4)[2] << 8) |
        randomBytes(4)[3]) >>>
      1;
    state = {
      keyId,
      iteration: 0,
      chainKey: randomBytes(32),
      signingKeyPublic: prependVersionByte(signingKey.pubKey),
      signingKeyPrivate: signingKey.privKey,
      messageKeys: {},
    };
    await store.storeSenderKey(senderKeyName, state);
  }

  const proto = encodeSenderKeyDistributionProto({
    id: state.keyId,
    iteration: state.iteration,
    chainKey: state.chainKey,
    signingKey: state.signingKeyPublic,
  });

  return concatBytes(new Uint8Array([SENDERKEY_VERSION_BYTE]), proto);
}

/**
 * Process an incoming SenderKeyDistributionMessage from a group peer.
 */
export async function processSenderKeyDistributionMessage(
  store: SignalProtocolStore,
  senderKeyName: string,
  skdmBytes: Uint8Array
): Promise<void> {
  if (skdmBytes.length < 2) {
    throw new Error('SenderKeyDistributionMessage too short');
  }
  const decoded = decodeSenderKeyDistributionProto(skdmBytes.slice(1));
  if (
    decoded.id === undefined ||
    decoded.iteration === undefined ||
    !decoded.chainKey ||
    !decoded.signingKey
  ) {
    throw new Error('Incomplete SenderKeyDistributionMessage');
  }

  const state: SenderKeyState = {
    keyId: decoded.id,
    iteration: decoded.iteration,
    chainKey: decoded.chainKey,
    signingKeyPublic: prependVersionByte(decoded.signingKey),
    messageKeys: {},
  };
  await store.storeSenderKey(senderKeyName, state);
}

/**
 * Encrypt a group message using our SenderKey for `senderKeyName`.
 */
export async function encryptSenderKeyMessage(
  store: SignalProtocolStore,
  senderKeyName: string,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  const state = await store.loadSenderKey(senderKeyName);
  if (!state || !state.signingKeyPrivate) {
    throw new Error(`No local SenderKey initialized for ${senderKeyName}`);
  }

  const { iv, cipherKey } = deriveSenderMessageKey(state.chainKey);
  const iteration = state.iteration;
  const ciphertext = await aesCbcEncrypt(cipherKey, iv, plaintext);

  const proto = encodeSenderKeyMessageProto({
    id: state.keyId,
    iteration,
    ciphertext,
  });
  const versionAndProto = concatBytes(new Uint8Array([SENDERKEY_VERSION_BYTE]), proto);
  const signature = calculateSignature(state.signingKeyPrivate, versionAndProto);

  state.chainKey = advanceSenderChainKey(state.chainKey);
  state.iteration += 1;
  await store.storeSenderKey(senderKeyName, state);

  return concatBytes(versionAndProto, signature);
}

/**
 * Decrypt an incoming group SenderKeyMessage (EnvelopeType.SENDERKEY_MESSAGE).
 */
export async function decryptSenderKeyMessage(
  store: SignalProtocolStore,
  senderKeyName: string,
  skmBytes: Uint8Array
): Promise<Uint8Array> {
  if (skmBytes.length < 2 + SIGNATURE_LENGTH) {
    throw new Error('SenderKeyMessage too short');
  }
  const versionAndProto = skmBytes.slice(0, skmBytes.length - SIGNATURE_LENGTH);
  const signature = skmBytes.slice(skmBytes.length - SIGNATURE_LENGTH);

  const state = await store.loadSenderKey(senderKeyName);
  if (!state) {
    throw new Error(`No SenderKey state for ${senderKeyName}`);
  }

  if (!verifySignature(state.signingKeyPublic, versionAndProto, signature)) {
    throw new Error('Invalid signature on SenderKeyMessage');
  }

  const decoded = decodeSenderKeyMessageProto(versionAndProto.slice(1));
  if (decoded.id !== state.keyId || decoded.iteration === undefined || !decoded.ciphertext) {
    throw new Error('SenderKeyMessage keyId mismatch or malformed payload');
  }

  const targetIter = decoded.iteration;
  let iv: Uint8Array;
  let cipherKey: Uint8Array;

  if (state.iteration > targetIter) {
    const seed = state.messageKeys[targetIter];
    if (!seed) {
      throw new Error(`Duplicate or expired SenderKey iteration ${targetIter}`);
    }
    delete state.messageKeys[targetIter];
    const derived = hkdfSha256(seed, WHISPER_GROUP_INFO, 48);
    iv = derived.slice(0, 16);
    cipherKey = derived.slice(16, 48);
  } else {
    if (targetIter - state.iteration > MAX_SKIPPED_SENDER_KEYS) {
      throw new Error('Too many skipped SenderKey iterations');
    }
    while (state.iteration < targetIter) {
      const step = deriveSenderMessageKey(state.chainKey);
      state.messageKeys[state.iteration] = step.seed;
      state.chainKey = advanceSenderChainKey(state.chainKey);
      state.iteration += 1;
    }
    const finalStep = deriveSenderMessageKey(state.chainKey);
    iv = finalStep.iv;
    cipherKey = finalStep.cipherKey;
    state.chainKey = advanceSenderChainKey(state.chainKey);
    state.iteration += 1;
  }

  const plaintext = await aesCbcDecrypt(cipherKey, iv, decoded.ciphertext);
  await store.storeSenderKey(senderKeyName, state);
  return plaintext;
}
