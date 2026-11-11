/* Incoming WebSocket frames: decoding, ACKs, and turning a decrypted envelope into the app's JSON frame. */

import { decodeWebSocketMessage, encodeWebSocketRequest, encodeWebSocketResponse, isAci } from '../net/proto';
import { isFromBlocked } from './blocked';
import { client, store } from './context';
import { recordPeerProfileKey, updateSyncedContact } from './contacts';
import { noteIncomingGroup } from './group-state';
import { applyOwnKeyChanges, handleIncomingSyncMessage } from './sync-handlers';

export const incomingMethods = {
  /** Decode a binary WebSocket frame from `wss://chat.signal.org/v1/websocket/`. */
  decodeWsFrame(buf: ArrayBuffer | Uint8Array) {
    return decodeWebSocketMessage(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  },

  /** Encode a WebSocket response ACK for a processed request ID. */
  encodeWsAck(id: bigint, status = 200, message = 'OK'): Uint8Array {
    return encodeWebSocketResponse(id, status, message);
  },

  /** Encode a WebSocket keepalive request (`GET /v1/keepalive`). */
  encodeWsKeepalive(): Uint8Array {
    return encodeWebSocketRequest('GET', '/v1/keepalive', BigInt(Date.now()));
  },

  /**
   * Decrypt a binary Signal `Envelope` from a WebSocket `/api/v1/message` request and return the JSON frame for the app's store.
   */
  async processIncomingEnvelope(envelopeBytes: Uint8Array): Promise<{ envelope: any } | null> {
    const res = await client.enqueueDecryptEnvelope(envelopeBytes, applyOwnKeyChanges);
    if (!res) return null;
    const c = res.content.content;
    const sender = res.envelope.sourceUuid;
    const acc = await store.getAccount();
    const fromSelf = !!acc && sender === acc.aci;

    if (c.case === 'syncMessage' && !fromSelf) return null;
    if (!fromSelf && (await isFromBlocked(res.envelope, res.content))) return null;

    if (c.case === 'dataMessage') {
      const dm = c.value;
      if (dm.profileKey.length === 32) recordPeerProfileKey(sender, res.envelope.sourceE164, dm.profileKey).catch(() => {});
      if (dm.groupV2 && dm.groupV2.masterKey.length === 32) {
        noteIncomingGroup(dm.groupV2.masterKey, dm.groupV2.revision, sender, dm.expireTimer, dm.groupV2.groupChange, res.envelope.timestamp).catch(() => {});
      } else if (dm.expireTimerVersion && isAci(sender)) {
        updateSyncedContact({ aci: sender, e164: res.envelope.sourceE164 || '' }, (ct) => {
          if (dm.expireTimerVersion >= (ct.expireTimerVersion || 0)) {
            ct.expireTimerVersion = dm.expireTimerVersion;
            ct.expireTimer = dm.expireTimer;
          }
        }).catch(() => {});
      }
    }

    if (c.case === 'syncMessage') {
      const sent = c.value.content.case === 'sent' ? c.value.content.value.message : undefined;
      if (sent && sent.groupV2 && sent.groupV2.masterKey.length === 32) {
        noteIncomingGroup(sent.groupV2.masterKey, sent.groupV2.revision, sender, sent.expireTimer, sent.groupV2.groupChange, res.envelope.timestamp).catch(() => {});
      }
      handleIncomingSyncMessage(res.envelope, res.content).catch(() => {});
    }
    return res.normalizedFrame;
  },
};
