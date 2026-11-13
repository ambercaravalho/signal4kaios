/* 1:1 voice calls: the call manager wired to the account, Signal's relays, and libsignal's call keys and Opus codec. */

import { uuidToBytes } from '../bytes';
import {
  ContentSchema,
  SyncMessage_CallEvent_Direction,
  SyncMessage_CallEvent_Event,
  SyncMessage_CallEvent_Type,
  SyncMessage_CallEventSchema,
  type CallMessage,
} from '../gen/SignalService_pb';
import { host } from '../host';
import { CallManager, type CallRecord, type CallState } from '../calling/manager';
import { CALL_SAMPLE_RATE, CallAudio, OPUS_BITRATE, OPUS_COMPLEXITY } from '../calling/media';
import { fetchRelays, openRelay } from '../calling/relays';
import { accountBasicAuth } from '../net/http';
import { create } from '../net/proto';
import { connectTcp } from '../net/transport/tcp';
import { libsignal } from '../protocol/libsignal';
import { callIdentityKeys } from '../protocol/protocol';
import { client, httpJson, store } from './context';

async function account() {
  const acc = await store.getAccount();
  if (!acc) throw new Error('not linked');
  return acc;
}

/** The chat line for a call, handled by the app like a decrypted frame. */
function recordFrame(rec: CallRecord) {
  return {
    envelope: {
      source: rec.peer,
      sourceUuid: rec.peer,
      sourceDevice: 1,
      timestamp: rec.timestamp,
      callRecord: { callId: rec.callId, direction: rec.direction, outcome: rec.outcome, durationMs: rec.durationMs },
    },
  };
}

export const callManager = new CallManager({
  async self() {
    const acc = await account();
    return { aci: acc.aci, deviceId: acc.deviceId };
  },
  async send(peer: string, msg: CallMessage, urgent: boolean) {
    await client.sendContentToRecipient(peer, create(ContentSchema, { content: { case: 'callMessage', value: msg } }), Date.now(), false, urgent);
  },
  identityKeys: (peer) => callIdentityKeys(store, peer),
  async openRelay() {
    // SECURITY-REVIEW: the account password authorizes the relay request; the relay credentials it returns stay inside the TURN client.
    const relays = await fetchRelays(httpJson, accountBasicAuth(await account()));
    let last: unknown = new Error('Signal returned no relays');
    for (const r of relays) {
      try {
        return await openRelay(r, connectTcp);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  },
  newKeys: () => new libsignal.CallKeyPair(),
  newAudio: () => new CallAudio(new libsignal.OpusEncoder(CALL_SAMPLE_RATE, OPUS_BITRATE, OPUS_COMPLEXITY), new libsignal.OpusDecoder(CALL_SAMPLE_RATE)),
  record: (rec) => host().ingest(recordFrame(rec)),
  syncEvent(rec, event) {
    const callEvent = create(SyncMessage_CallEventSchema, {
      conversationId: uuidToBytes(rec.peer),
      callId: BigInt(rec.callId),
      timestamp: BigInt(rec.timestamp),
      type: SyncMessage_CallEvent_Type.AUDIO_CALL,
      direction: rec.direction === 'incoming' ? SyncMessage_CallEvent_Direction.INCOMING : SyncMessage_CallEvent_Direction.OUTGOING,
      event: event === 'accepted' ? SyncMessage_CallEvent_Event.ACCEPTED : SyncMessage_CallEvent_Event.NOT_ACCEPTED,
    });
    const content = create(ContentSchema, { content: { case: 'syncMessage', value: { content: { case: 'callEvent', value: callEvent } } } });
    client.sendSyncMessage(content).catch((err) => host().dbg(`call: call event not synced (${err && err.message})`));
  },
  log: (msg) => host().dbg(msg),
});

export const callMethods = {
  startCall: (peer: string) => callManager.startCall(peer),
  acceptCall: () => callManager.accept(),
  declineCall: () => callManager.decline(),
  ignoreCall: () => callManager.ignore(),
  hangupCall: () => callManager.hangup(),
  setCallMuted: (muted: boolean) => callManager.setMuted(muted),
  dismissCall: () => callManager.dismiss(),
  callState: (): CallState | null => callManager.state,
  onCallState: (fn: (state: CallState | null) => void) => callManager.subscribe(fn),
  /** Microphone samples at `callSampleRate`. */
  callCapture: (pcm: Float32Array) => callManager.capture(pcm),
  /** The peer's audio for the speaker, or null while there is none. */
  callPull: () => callManager.pull(),
  callSampleRate: CALL_SAMPLE_RATE,
};
