/* What our other devices tell us: Storage Service pulls, sync messages from our own devices, and number changes from the primary phone. */

import { bytesToUuid, fromBase64, toBase64 } from '../bytes';
import { DeviceNameSchema } from '../gen/DeviceName_pb';
import { type Content, SyncMessage_FetchLatest_Type, SyncMessage_MessageRequestResponse_Type, Verified_State } from '../gen/SignalService_pb';
import { type ChatStateEntry, host } from '../host';
import { accountBasicAuth, asObject } from '../net/http';
import { fromBinary, isAci, serviceIdFrom } from '../net/proto';
import { decryptDeviceName } from '../net/provisioning';
import { type DecryptedEnvelope, type IncomingEnvelope, parseContactsSyncBlob } from '../net/receive';
import { libsignal } from '../protocol/libsignal';
import { generatePreKeyUpload } from '../protocol/prekeys';
import type { TrustLevel } from '../protocol/store';
import { applyPniChangeNumber, type NumberChange } from '../services/change-number';
import { deriveGroupV2Keys } from '../services/groups-v2';
import { adoptOwnProfileKey } from '../services/profiles';
import { pullFromStorageService } from '../services/storage';
import { usernameLinkUrl } from '../services/usernames';
import { invalidateBlocked } from './blocked';
import { client, httpBinary, httpJson, OWN_AVATAR_PATH, serverUrl, store } from './context';
import { contactIds, mergeSyncedContacts, saveSyncedContacts, saveSyncedGroups, syncedContacts, syncedGroups, updateSyncedContact, updateSyncedGroup } from './contacts';
import { refreshGroup } from './group-state';

const MAX_DEVICE_NAME = 64;

/**
 * Pull contacts, Groups V2 master keys, and account settings from Signal's Storage Service.
 */
export async function syncFromStorageService(): Promise<boolean> {
  const res = await pullFromStorageService(store, httpJson, httpBinary, serverUrl());
  if (!res) return false;
  const chatState: ChatStateEntry[] = [];

  if (res.contacts.length > 0) {
    for (const sc of res.contacts) {
      if (!(sc.aci || sc.e164)) continue;
      if (sc.aci && sc.profileKey) client.setPeerProfileKey(sc.aci, sc.profileKey);
      if (sc.aci && sc.identityKey) {
        await store.saveIdentity(sc.aci, sc.identityKey, { uuid: sc.aci, number: sc.e164 });
        if (sc.identityState) await store.setIdentityTrust(sc.aci, sc.identityState);
      }
      if (sc.changed) chatState.push({ uuid: sc.aci || '', number: sc.e164 || '', archived: !!sc.archived, mutedUntil: sc.mutedUntilTimestamp || 0, markedUnread: !!sc.markedUnread, callsIfMuted: sc.notifyForCallsIfMuted ?? null });
    }
    await mergeSyncedContacts(
      res.contacts,
      (sc) => sc.aci || sc.e164,
      (sc, prev) => ({
        ...prev,
        uuid: sc.aci || prev.uuid || '',
        number: sc.e164 || prev.number || '',
        name: [sc.nicknameGivenName, sc.nicknameFamilyName].filter(Boolean).join(' ') || [sc.givenName, sc.familyName].filter(Boolean).join(' ') || prev.name || sc.username || sc.e164 || sc.aci || '',
        username: sc.username || prev.username,
        blocked: sc.blocked ?? prev.blocked ?? false,
        whitelisted: !!sc.whitelisted,
        systemContact: !!sc.systemContact,
        profileKey: sc.profileKey ? toBase64(sc.profileKey) : prev.profileKey,
      })
    );
  }

  if (res.groupsV2.length > 0) {
    const byGrpId = new Map<string, any>();
    for (const g of await syncedGroups()) byGrpId.set(g.internal_id, g);

    for (const gv2 of res.groupsV2) {
      const keys = deriveGroupV2Keys(gv2.masterKey);
      const prev = byGrpId.get(keys.internalId) || {};
      byGrpId.set(keys.internalId, {
        ...prev,
        id: keys.sendId,
        internal_id: keys.internalId,
        masterKey: toBase64(gv2.masterKey),
        name: prev.name || 'Group',
        members: prev.members || [],
        blocked: gv2.blocked ?? prev.blocked ?? false,
        archived: gv2.archived ?? prev.archived ?? false,
        whitelisted: !!gv2.whitelisted,
        messageRequest: gv2.whitelisted ? undefined : prev.messageRequest,
      });
      if (gv2.changed) {
        chatState.push({
          groupInternalId: keys.internalId,
          archived: !!gv2.archived,
          mutedUntil: gv2.mutedUntilTimestamp || 0,
          markedUnread: !!gv2.markedUnread,
          mentionsIfMuted: gv2.notifyForMentionsIfMuted ?? null,
          repliesIfMuted: gv2.notifyForRepliesIfMuted ?? null,
          callsIfMuted: gv2.notifyForCallsIfMuted ?? null,
        });
      }
    }
    await saveSyncedGroups(Array.from(byGrpId.values()));
    for (const gv2 of res.groupsV2) {
      await refreshGroup(gv2.masterKey).catch((e: any) => host().dbg('group refresh failed: ' + (e && e.message)));
    }
  }

  const account = res.account;
  if (account) {
    if (await adoptOwnProfileKey(store, account.profileKey)) host().dbg('storage: adopted the profile key from the account record');
    await store.storeValue(OWN_AVATAR_PATH, account.avatarUrlPath || '');
    const patch: Record<string, any> = {};
    const fullName = [account.givenName, account.familyName].filter(Boolean).join(' ');
    if (fullName) patch.profileName = fullName;
    patch.username = account.username || '';
    const link = account.usernameLink;
    if (account.username && link) {
      patch.usernameLink = usernameLinkUrl(link.entropy, link.serverId);
      await store.storeValue('usernameLink', { entropy: toBase64(link.entropy), serverId: bytesToUuid(link.serverId) });
    } else {
      patch.usernameLink = '';
    }
    if (account.readReceipts !== undefined) patch.sendReadReceipts = account.readReceipts;
    if (account.typingIndicators !== undefined) patch.typingIndicators = account.typingIndicators;
    if (account.linkPreviews !== undefined) patch.linkPreviews = account.linkPreviews;
    if (account.sealedSenderIndicators !== undefined) patch.sealedSenderIndicators = account.sealedSenderIndicators;
    if (account.universalExpireTimer !== undefined) patch.defaultExpireTimer = account.universalExpireTimer;
    patch.sharePhoneNumber = account.sharePhoneNumber;
    patch.findableByNumber = account.findableByNumber;
    patch.notifyMentionsIfMuted = account.notifyForMentionsIfMuted;
    patch.notifyRepliesIfMuted = account.notifyForRepliesIfMuted;
    patch.notifyCallsIfMuted = account.notifyForCallsIfMuted;
    patch.notifyReactions = account.reactionNotifications;
    patch.notificationProfileOverride = account.notificationProfileOverride;
    patch.notificationProfiles = account.notificationProfileSyncDisabled ? [] : res.notificationProfiles;
    host().config.set(patch);
    const acc = await store.getAccount();
    if (acc && account.changed) chatState.push({ uuid: acc.aci, number: acc.number || '', archived: !!account.noteToSelfArchived, markedUnread: !!account.noteToSelfMarkedUnread });
  }

  invalidateBlocked();
  await host().directoryChanged().catch(() => {});
  const pinned =
    account && account.changed
      ? account.pinnedConversations.map((p) => (p.groupMasterKey ? { groupInternalId: deriveGroupV2Keys(p.groupMasterKey).internalId } : { uuid: p.aci || '', number: p.e164 || '' }))
      : null;
  host().applyChatState(chatState, pinned);
  return true;
}

/** Signal-Desktop `onDeviceNameChangeSync`: the phone renamed this device, so read the new name back from the server. */
async function refreshOwnDeviceName(): Promise<void> {
  const acc = await store.getAccount();
  if (!acc) return;
  // SECURITY-REVIEW: the device list is fetched with this device's credentials; the name is decrypted with our ACI identity key, which stays in the protocol store.
  const res = asObject(await httpJson('GET', '/v1/devices', null, { basicAuth: accountBasicAuth(acc) }));
  const devices: any[] = res && Array.isArray(res.devices) ? res.devices : [];
  const ours = devices.find((d) => d && d.id === acc.deviceId);
  if (!ours || typeof ours.name !== 'string' || !ours.name) return;
  const name = (await decryptDeviceName(fromBinary(DeviceNameSchema, fromBase64(ours.name)), acc.aciIdentityKeyPair.privKey)).trim();
  if (name) host().config.set({ deviceName: name.slice(0, MAX_DEVICE_NAME) });
}

/** A number change from our primary phone, applied inside the decryption queue as Signal-Desktop does: the envelopes after it may be addressed to the new PNI. */
export async function applyOwnKeyChanges(res: DecryptedEnvelope): Promise<void> {
  const c = res.content.content;
  if (c.case !== 'syncMessage' || c.value.content.case !== 'pniChangeNumber') return;
  let change: NumberChange | null;
  try {
    change = await applyPniChangeNumber(store, res.envelope, c.value.content.value);
  } catch (e: any) {
    host().dbg('sync: number change rejected: ' + (e && e.message));
    return;
  }
  if (!change) {
    host().dbg('sync: incomplete number change ignored');
    return;
  }
  host().dbg('sync: our number changed');
  client.clearSenderCertificate();
  host().numberChanged(change.number);
  const acc = await store.getAccount();
  if (!acc || !acc.pniIdentityKeyPair) return;
  const pniKeys = acc.pniIdentityKeyPair;
  const basicAuth = accountBasicAuth(acc);
  generatePreKeyUpload(store, 'pni', pniKeys)
    .then((body) => httpJson('PUT', '/v2/keys?identity=pni', body, { basicAuth }))
    .catch((e: any) => host().dbg('sync: PNI PreKey upload after the number change failed: ' + (e && e.message)));
}

export async function handleIncomingSyncMessage(env: IncomingEnvelope, content: Content): Promise<void> {
  if (content.content.case !== 'syncMessage') return;
  const acc = await store.getAccount();
  // Sync messages are only meaningful from our own devices
  if (!acc || env.sourceUuid !== acc.aci) return;
  const c = content.content.value.content;

  switch (c.case) {
    case 'contacts': {
      if (!c.value.blob) break;
      try {
        const { bytes } = await client.downloadAttachment(c.value.blob);
        await mergeSyncedContacts(
          parseContactsSyncBlob(bytes),
          (sc) => sc.uuid || sc.number,
          (sc, prev) => ({ ...prev, uuid: sc.uuid || prev.uuid || '', number: sc.number || prev.number || '', name: sc.name || prev.name, expireTimer: sc.expireTimer, blocked: prev.blocked ?? false })
        );
        host().directoryChanged().catch(() => {});
      } catch (e: any) {
        host().dbg('sync contacts blob failed: ' + (e && e.message));
      }
      break;
    }
    case 'verified': {
      const v = c.value;
      const aci = v.destinationAci;
      if (!isAci(aci)) break;
      if (v.identityKey.length === 33) await store.saveIdentity(aci, v.identityKey, { uuid: aci });
      const level: TrustLevel =
        v.state === Verified_State.VERIFIED ? 'TRUSTED_VERIFIED' : v.state === Verified_State.UNVERIFIED ? 'UNTRUSTED' : 'TRUSTED_UNVERIFIED';
      await store.setIdentityTrust(aci, level);
      break;
    }
    case 'blocked': {
      const b = c.value;
      const blockedNums = new Set(b.numbers);
      const blockedAcis = new Set(b.acis);
      const blockedGrpIds = new Set(b.groupIds.map((g) => toBase64(g)));
      const contacts = await syncedContacts();
      for (const ct of contacts) ct.blocked = (ct.number && blockedNums.has(ct.number)) || (ct.uuid && blockedAcis.has(ct.uuid));
      await saveSyncedContacts(contacts);
      const groups = await syncedGroups();
      for (const g of groups) g.blocked = blockedGrpIds.has(g.internal_id);
      await saveSyncedGroups(groups);
      invalidateBlocked();
      break;
    }
    case 'messageRequestResponse': {
      const aci = serviceIdFrom(c.value.threadAci, c.value.threadAciBinary);
      const accepted = c.value.type === SyncMessage_MessageRequestResponse_Type.ACCEPT;
      if (c.value.groupId && c.value.groupId.length) {
        await updateSyncedGroup(toBase64(c.value.groupId), (g) => {
          if (accepted) g.whitelisted = true;
          delete g.messageRequest;
        });
      } else if (accepted && isAci(aci)) {
        await updateSyncedContact(await contactIds(aci), (ct) => {
          ct.whitelisted = true;
        });
      }
      break;
    }
    case 'configuration': {
      const cfg = c.value;
      host().config.set({
        sendReadReceipts: cfg.readReceipts,
        typingIndicators: cfg.typingIndicators,
        linkPreviews: cfg.linkPreviews,
        sealedSenderIndicators: cfg.unidentifiedDeliveryIndicators,
      });
      break;
    }
    case 'usernameChange':
      syncFromStorageService().catch(() => {});
      break;
    case 'deviceNameChange':
      if (c.value.deviceId === acc.deviceId) refreshOwnDeviceName().catch((e: any) => host().dbg('device name refresh failed: ' + (e && e.message)));
      break;
    case 'keys': {
      const k = c.value;
      let masterKey: Uint8Array | undefined;
      if (k.accountEntropyPool) {
        try {
          masterKey = libsignal.accountEntropyPoolDeriveMasterKey(k.accountEntropyPool);
        } catch {
          // fall back to the raw master key
        }
      }
      if (!masterKey && k.master.length === 32) masterKey = k.master;
      if (masterKey) {
        // SECURITY-REVIEW: master key and Account Entropy Pool are stored only in the on-device protocol store
        await store.saveAccount({ ...acc, masterKey, accountEntropyPool: k.accountEntropyPool || acc.accountEntropyPool });
        syncFromStorageService().catch(() => {});
      }
      break;
    }
    case 'fetchLatest':
      if (c.value.type === SyncMessage_FetchLatest_Type.STORAGE_MANIFEST) syncFromStorageService().catch(() => {});
      break;
    default:
      break;
  }
}
