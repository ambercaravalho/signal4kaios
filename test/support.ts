/* Shared helpers for the Node unit tests: loads the libsignal wasm build and creates linked test accounts. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MessageInitShape } from '@bufbuild/protobuf';

import { ContentSchema, EnvelopeSchema } from '../engine/gen/SignalService_pb';
import { libsignal, loadLibsignalSync } from '../engine/protocol/libsignal';
import { create, toBinary } from '../engine/net/proto';
import { generatePreKeyUpload } from '../engine/protocol/prekeys';
import { localIdentity, parsePreKeyResponse, processPreKeyBundle } from '../engine/protocol/protocol';
import { MemorySignalStore } from '../engine/protocol/store';

export function loadWasmForTests(): string {
  return loadLibsignalSync(readFileSync(join(process.cwd(), 'app/vendor/libsignal_wasm_bg.wasm')));
}

export interface TestAccount {
  aci: string;
  deviceId: number;
  store: MemorySignalStore;
  identityPublic: Uint8Array;
}

export function newAccount(aci: string, deviceId: number, number = ''): TestAccount {
  const kp = libsignal.keyPairGenerate() as { publicKey: Uint8Array; privateKey: Uint8Array };
  const store = new MemorySignalStore({
    aci,
    number,
    deviceId,
    password: 'test-password',
    registrationId: libsignal.generateRegistrationId(),
    pniRegistrationId: libsignal.generateRegistrationId(),
    aciIdentityKeyPair: { pubKey: kp.publicKey, privKey: kp.privateKey },
  });
  return { aci, deviceId, store, identityPublic: kp.publicKey };
}

/** The JSON `GET /v2/keys/{aci}/{device}` would return for `account`, built from a freshly generated upload. */
export async function serverKeysFor(account: TestAccount, oneTime = 2): Promise<any> {
  const acc = (await account.store.getAccount())!;
  const upload = await generatePreKeyUpload(account.store, 'aci', acc.aciIdentityKeyPair, oneTime);
  const { toBase64 } = await import('../engine/bytes');
  return {
    identityKey: toBase64(acc.aciIdentityKeyPair.pubKey),
    devices: [
      {
        deviceId: account.deviceId,
        registrationId: acc.registrationId,
        preKey: upload.preKeys[0],
        signedPreKey: upload.signedPreKey,
        pqPreKey: upload.pqPreKeys[0],
      },
    ],
  };
}

/** Builds a session from `from` to `to` the way SignalClient does after fetching PreKeys. */
export async function connect(from: TestAccount, to: TestAccount, oneTime = 2): Promise<any> {
  const keys = await serverKeysFor(to, oneTime);
  const [bundle] = parsePreKeyResponse(keys);
  await from.store.saveIdentity(to.aci, bundle.identityKey, { uuid: to.aci });
  await processPreKeyBundle(from.store, await localIdentity(from.store), to.aci, bundle);
  return keys;
}

export function contentBytes(init: MessageInitShape<typeof ContentSchema>): Uint8Array {
  return toBinary(ContentSchema, create(ContentSchema, init));
}

export function envelopeBytes(init: MessageInitShape<typeof EnvelopeSchema>): Uint8Array {
  return toBinary(EnvelopeSchema, create(EnvelopeSchema, init));
}
