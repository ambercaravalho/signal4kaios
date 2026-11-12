/* Things the app does to one person: nicknames, blocking, message requests, spam reports, their profile photo, and safety numbers. */

import { bytesToBlob, fromBase64 } from '../bytes';
import { ContentSchema, DataMessage_Flags, SyncMessage_MessageRequestResponse_Type, Verified_State } from '../gen/SignalService_pb';
import { ContactRecord_NameSchema } from '../gen/SignalStorage_pb';
import { host } from '../host';
import { create, isAci } from '../net/proto';
import { compareScannedSafetyNumber } from '../protocol/protocol';
import type { TrustLevel } from '../protocol/store';
import { downloadAndDecryptProfileAvatar, fetchAndDecryptProfile } from '../services/profiles';
import { reportSpam as reportSpamMessages } from '../services/report-spam';
import { invalidateBlocked, sendBlockedSync } from './blocked';
import { client, httpBinary, httpJson, serverUrl, storageQueue, store } from './context';
import { contactIds, resolveAci, saveSyncedContacts, syncedContacts, updateSyncedContact } from './contacts';
import { dataContent } from './delivery';

async function knownContact(id: string): Promise<{ aci: string; e164: string }> {
  const ids = await contactIds(id);
  if (!ids.aci && !ids.e164) throw new Error('No Signal account known for ' + id);
  return ids;
}

export const contactMethods = {
  /** Set or clear a contact's nickname (Storage Service `ContactRecord.nickname`, shown on all your devices). */
  async setContactNickname(id: string, name: string): Promise<void> {
    const ids = await knownContact(id);
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    const given = parts[0] || '';
    const family = parts.slice(1).join(' ');
    await storageQueue.enqueue([
      {
        type: 'contact',
        aci: ids.aci || undefined,
        e164: ids.e164 || undefined,
        update: (c) => {
          c.nickname = given || family ? create(ContactRecord_NameSchema, { given, family }) : undefined;
        },
      },
    ]);
  },

  /** Block or unblock a person like Signal-Desktop: Blocked sync to our devices, then `ContactRecord.blocked` (and profile sharing off while blocked) in Storage Service. */
  async setContactBlocked(id: string, blocked: boolean): Promise<void> {
    const ids = await knownContact(id);
    await updateSyncedContact(ids, (c) => {
      c.blocked = blocked;
    });
    invalidateBlocked();
    host().directoryChanged().catch(() => {});
    await sendBlockedSync();
    await storageQueue.enqueue([
      {
        type: 'contact',
        aci: ids.aci || undefined,
        e164: ids.e164 || undefined,
        update: (c) => {
          c.blocked = blocked;
          c.blockedAtTimestamp = blocked ? BigInt(Date.now()) : 0n;
          c.whitelisted = !blocked;
        },
      },
    ]);
  },

  /** Answer a 1:1 message request on our other devices. Accepting also shares our profile with them, in Storage Service and with a PROFILE_KEY_UPDATE message, as Signal-Desktop does. */
  async sendMessageRequestResponse(sendId: string, response: 'accept' | 'delete' | 'block' | 'blockAndSpam'): Promise<void> {
    const ids = await contactIds(sendId);
    if (!ids.aci) throw new Error('No Signal account known for ' + sendId);
    const type = {
      accept: SyncMessage_MessageRequestResponse_Type.ACCEPT,
      delete: SyncMessage_MessageRequestResponse_Type.DELETE,
      block: SyncMessage_MessageRequestResponse_Type.BLOCK,
      blockAndSpam: SyncMessage_MessageRequestResponse_Type.BLOCK_AND_SPAM,
    }[response];
    await client.sendSyncMessage(create(ContentSchema, { content: { case: 'syncMessage', value: { content: { case: 'messageRequestResponse', value: { threadAci: ids.aci, type } } } } }));
    if (response !== 'accept') return;
    await updateSyncedContact(ids, (c) => {
      c.whitelisted = true;
    });
    await storageQueue.enqueue([
      {
        type: 'contact',
        aci: ids.aci,
        e164: ids.e164 || undefined,
        update: (c) => {
          c.whitelisted = true;
        },
      },
    ]);
    const acc = await store.getAccount();
    if (!acc || !acc.profileKey || acc.profileKey.length !== 32) return;
    const ts = Date.now();
    await client.sendContentToRecipient(ids.aci, dataContent({ timestamp: BigInt(ts), flags: DataMessage_Flags.PROFILE_KEY_UPDATE, profileKey: acc.profileKey }), ts);
  },

  /** Report someone's messages (by server GUID) as spam to Signal, as Signal-Desktop's reportSpamJobQueue does; returns how many were reported. */
  async reportSpam(sendId: string, serverGuids: string[], token?: string): Promise<number> {
    const ids = await contactIds(sendId);
    if (!ids.aci) throw new Error('No Signal account known for ' + sendId);
    return reportSpamMessages(store, httpJson, ids.aci, serverGuids, token, serverUrl());
  },

  async fetchContactAvatarBlob(uuidOrNumber: string): Promise<Blob> {
    const cached = await host().db.getAttachment('avatar:' + uuidOrNumber);
    if (cached && cached.blob) return cached.blob;

    const contacts = await syncedContacts();
    const entry = contacts.find((c) => c.uuid === uuidOrNumber || c.number === uuidOrNumber);
    const uuid = (entry && entry.uuid) || uuidOrNumber;
    if (!isAci(uuid)) throw new Error('No profile avatar available');
    const pkBytes = client.getPeerProfileKey(uuid) || (entry && entry.profileKey ? fromBase64(entry.profileKey) : undefined);

    const prof = await fetchAndDecryptProfile(store, httpJson, uuid, pkBytes, serverUrl());
    if (prof && prof.fullName && entry && entry.profile_name !== prof.fullName) {
      entry.profile_name = prof.fullName;
      await saveSyncedContacts(contacts);
      host().directoryChanged().catch(() => {});
    }
    if (!prof || !prof.avatarUrlPath || !pkBytes) throw new Error('No profile avatar available');

    const blob = bytesToBlob(await downloadAndDecryptProfileAvatar(httpBinary, prof.avatarUrlPath, pkBytes), 'image/jpeg');
    await host().db.putAttachment('avatar:' + uuidOrNumber, blob, 'image/jpeg');
    return blob;
  },

  /** `target` is a contact's ACI or phone number. */
  async safetyNumber(target: string) {
    const aci = (await resolveAci(target)) || (await store.getAllIdentities()).find((r) => !!target && r.number === target)?.uuid || '';
    return aci ? client.safetyNumberFor(aci) : null;
  },

  async trustIdentity(target: string, opts?: { verified_safety_number?: string; trust_all_known_keys?: boolean }): Promise<void> {
    const level: TrustLevel = opts?.verified_safety_number ? 'TRUSTED_VERIFIED' : 'TRUSTED_UNVERIFIED';
    const aci = (await resolveAci(target)) || target;
    await store.setIdentityTrust(aci, level);

    const idRec = await store.getIdentity(aci);
    if (idRec && isAci(aci)) {
      await client.sendSyncMessage(
        create(ContentSchema, {
          content: {
            case: 'syncMessage',
            value: {
              content: {
                case: 'verified',
                value: {
                  destinationAci: aci,
                  identityKey: idRec.publicKey,
                  state: level === 'TRUSTED_VERIFIED' ? Verified_State.VERIFIED : Verified_State.DEFAULT,
                },
              },
            },
          },
        })
      );
    }
  },

  verifySafetyNumberQr(scannedString: string, expectedScannableB64: string, expectedSafetyNumber: string): boolean {
    try {
      const cleanDigits = scannedString.replace(/\D/g, '');
      if (cleanDigits.length === 60 && cleanDigits === expectedSafetyNumber) return true;
      // QR scanners hand back either base64 or a binary latin1 string
      let scannedBytes: Uint8Array;
      try {
        scannedBytes = fromBase64(scannedString);
      } catch {
        scannedBytes = new Uint8Array(scannedString.length);
        for (let i = 0; i < scannedString.length; i++) scannedBytes[i] = scannedString.charCodeAt(i) & 0xff;
      }
      return compareScannedSafetyNumber(fromBase64(expectedScannableB64), scannedBytes);
    } catch {
      return false;
    }
  },
};
