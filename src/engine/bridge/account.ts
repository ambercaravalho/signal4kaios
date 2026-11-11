/* Our own account: linking, PreKeys, profile and photo, username, privacy settings, and chat state shared through Storage Service. */

import type { MessageInitShape } from '@bufbuild/protobuf';

import { bytesToBlob, constantTimeEqual, fromBase64, toBase64, uuidToBytes } from '../bytes';
import { type AccountRecord_PinnedConversation, AccountRecord_PinnedConversationSchema, AccountRecord_UsernameLinkSchema } from '../gen/SignalStorage_pb';
import { host } from '../host';
import { accountBasicAuth, asObject } from '../net/http';
import { create, serviceIdFrom } from '../net/proto';
import { type ProvisioningCallbacks, type ProvisioningSession, startDeviceProvisioning } from '../net/provisioning';
import { generatePreKeyUpload } from '../protocol/prekeys';
import { downloadAndDecryptProfileAvatar, fetchAndDecryptProfile, resolveSignalUsername, uploadOwnProfile } from '../services/profiles';
import { setNotifyForMentionsIfMuted, setPhoneNumberPrivacy, type StorageMutation } from '../services/storage';
import { deleteUsername as deleteAccountUsername, setUsername as setAccountUsername, usernameLinkUrl } from '../services/usernames';
import { client, httpBinary, httpJson, OWN_AVATAR_CACHE, OWN_AVATAR_CACHED_FOR, OWN_AVATAR_PATH, serverUrl, storageQueue, store, updateAccountRecord } from './context';
import { contactIds } from './contacts';
import { groupMasterKey } from './group-state';
import { syncFromStorageService } from './sync-handlers';

const DEFAULT_PROFILE_NAME = 'Signal User';

export const accountMethods = {
  /** Start QR code provisioning for linking this KaiOS phone as a Signal secondary device. */
  startProvisioning(deviceName: string, callbacks: ProvisioningCallbacks): ProvisioningSession {
    const url = serverUrl();
    return startDeviceProvisioning(store, httpJson, deviceName, callbacks, { httpUrl: url, wsUrl: url.replace(/^http/, 'ws') });
  },

  /** Request contacts, blocked list, configuration, and keys from the primary device, and pull Storage Service. */
  async requestSync(): Promise<void> {
    await syncFromStorageService().catch(() => {});
    await client.requestInitialSync();
  },

  /** Rotate the signed and last-resort Kyber PreKeys and upload fresh one-time EC and Kyber PreKeys for both identities. */
  async replenishPreKeys(): Promise<void> {
    const acc = await store.getAccount();
    if (!acc) return;
    const basicAuth = accountBasicAuth(acc);
    await httpJson('PUT', '/v2/keys?identity=aci', await generatePreKeyUpload(store, 'aci', acc.aciIdentityKeyPair), { basicAuth });
    if (acc.pniIdentityKeyPair) {
      await httpJson('PUT', '/v2/keys?identity=pni', await generatePreKeyUpload(store, 'pni', acc.pniIdentityKeyPair), { basicAuth }).catch(() => {});
    }
  },

  /** Our own profile photo, cached under `avatar:self` for the path it was downloaded from; null when we have none. */
  async ownAvatarBlob(): Promise<Blob | null> {
    const acc = await store.getAccount();
    if (!acc || !acc.profileKey) return null;
    let path = (await store.loadValue(OWN_AVATAR_PATH)) as string | undefined;
    if (path === undefined) {
      const prof = await fetchAndDecryptProfile(store, httpJson, acc.aci, acc.profileKey, serverUrl());
      if (!prof) return null;
      path = prof.avatarUrlPath || '';
      await store.storeValue(OWN_AVATAR_PATH, path);
    }
    if (!path) return null;
    if ((await store.loadValue(OWN_AVATAR_CACHED_FOR)) === path) {
      const cached = await host().db.getAttachment(OWN_AVATAR_CACHE);
      if (cached && cached.blob && cached.blob.size) return cached.blob;
    }
    const blob = bytesToBlob(await downloadAndDecryptProfileAvatar(httpBinary, path, acc.profileKey), 'image/jpeg');
    await host().db.putAttachment(OWN_AVATAR_CACHE, blob, 'image/jpeg');
    await store.storeValue(OWN_AVATAR_CACHED_FOR, path);
    return blob;
  },

  /** Set our profile photo to `jpeg`, or remove it with null, like Signal-Desktop's `writeProfile`; the new path goes to `AccountRecord.avatarUrlPath` so our other devices pick it up. */
  async setOwnAvatar(jpeg: Uint8Array | null): Promise<void> {
    const res = await uploadOwnProfile(
      store,
      httpJson,
      { name: host().config.profileName() || DEFAULT_PROFILE_NAME, sharePhoneNumber: host().config.sharePhoneNumber(), avatar: jpeg },
      serverUrl(),
      { httpBinary }
    );
    if (!res || res.avatarUrlPath === undefined) throw new Error('The profile was not written');
    const path = res.avatarUrlPath || '';
    if (jpeg) {
      await host().db.putAttachment(OWN_AVATAR_CACHE, bytesToBlob(jpeg, 'image/jpeg'), 'image/jpeg');
      await store.storeValue(OWN_AVATAR_CACHED_FOR, path);
    }
    await store.storeValue(OWN_AVATAR_PATH, path);
    await updateAccountRecord((a) => {
      a.avatarUrlPath = path;
    });
  },

  async updateOwnProfile(body: { name?: string; about?: string; emoji?: string }): Promise<void> {
    await uploadOwnProfile(
      store,
      httpJson,
      { name: body.name || host().config.profileName() || DEFAULT_PROFILE_NAME, about: body.about, emoji: body.emoji, sharePhoneNumber: host().config.sharePhoneNumber() },
      serverUrl()
    ).catch(() => {});
  },

  /** Who sees our number (`AccountRecord.phoneNumberSharingMode`, and the profile's sharing flag) and who can find us by it (`unlistedPhoneNumber`), shared with our other devices. */
  async setPhoneNumberPrivacy(share: boolean, findable: boolean): Promise<void> {
    await updateAccountRecord((a) => setPhoneNumberPrivacy(a, share, findable));
    host().config.set({ sharePhoneNumber: share, findableByNumber: share || findable });
    await uploadOwnProfile(store, httpJson, { name: host().config.profileName(), sharePhoneNumber: share }, serverUrl());
  },

  /** Publish a chat's archive, mute, marked-unread, or pinned state to Storage Service so the account's other devices match. Only the fields that are set change. */
  async syncChatState(chat: { type: 'direct' | 'group'; sendId: string; archived?: boolean; muted?: boolean; markedUnread?: boolean; pinned?: boolean; mentionsIfMuted?: boolean }): Promise<void> {
    const mutations: StorageMutation[] = [];
    const setState = (r: { archived: boolean; mutedUntilTimestamp: bigint; markedUnread: boolean }) => {
      if (chat.archived !== undefined) r.archived = chat.archived;
      if (chat.muted !== undefined) r.mutedUntilTimestamp = chat.muted ? BigInt(Number.MAX_SAFE_INTEGER) : 0n;
      if (chat.markedUnread !== undefined) r.markedUnread = chat.markedUnread;
    };
    const stateChanged = chat.archived !== undefined || chat.muted !== undefined || chat.markedUnread !== undefined;
    let isPin: (p: AccountRecord_PinnedConversation) => boolean;
    let pin: MessageInitShape<typeof AccountRecord_PinnedConversationSchema>;

    if (chat.type === 'group') {
      const masterKey = await groupMasterKey(chat.sendId);
      if (stateChanged || chat.mentionsIfMuted !== undefined) {
        mutations.push({
          type: 'groupV2',
          masterKey,
          update: (g) => {
            setState(g);
            if (chat.mentionsIfMuted !== undefined) setNotifyForMentionsIfMuted(g, chat.mentionsIfMuted);
          },
        });
      }
      isPin = (p) => p.identifier.case === 'groupMasterKey' && constantTimeEqual(p.identifier.value, masterKey);
      pin = { identifier: { case: 'groupMasterKey', value: masterKey } };
    } else {
      const acc = await store.getAccount();
      const ids = await contactIds(chat.sendId);
      if (!ids.aci && !ids.e164) throw new Error('No Signal account known for ' + chat.sendId);
      const self = !!acc && (ids.aci === acc.aci || (!!ids.e164 && ids.e164 === acc.number));
      if (self && (chat.archived !== undefined || chat.markedUnread !== undefined)) {
        mutations.push({
          type: 'account',
          update: (a) => {
            if (chat.archived !== undefined) a.noteToSelfArchived = chat.archived;
            if (chat.markedUnread !== undefined) a.noteToSelfMarkedUnread = chat.markedUnread;
          },
        });
      } else if (!self && stateChanged) {
        mutations.push({ type: 'contact', aci: ids.aci || undefined, e164: ids.e164 || undefined, update: setState });
      }
      isPin = (p) => {
        if (p.identifier.case !== 'contact') return false;
        const c = p.identifier.value;
        const aci = serviceIdFrom(c.serviceId, c.serviceIdBinary);
        return (!!ids.aci && aci === ids.aci) || (!!ids.e164 && c.e164 === ids.e164);
      };
      pin = { identifier: { case: 'contact', value: { serviceId: ids.aci, serviceIdBinary: ids.aci ? uuidToBytes(ids.aci) : undefined, e164: ids.e164 } } };
    }

    if (chat.pinned !== undefined) {
      mutations.push({
        type: 'account',
        update: (a) => {
          const rest = a.pinnedConversations.filter((p) => !isPin(p));
          if (chat.pinned) rest.push(create(AccountRecord_PinnedConversationSchema, pin));
          a.pinnedConversations = rest;
        },
      });
    }
    await storageQueue.enqueue(mutations);
  },

  /** The disappearing-message timer new 1:1 chats start with (`AccountRecord.universalExpireTimer`), shared with our other devices. */
  async setUniversalExpireTimer(seconds: number): Promise<void> {
    const secs = Math.max(0, Math.floor(seconds) || 0);
    await updateAccountRecord((a) => {
      a.universalExpireTimer = secs;
    });
  },

  /** Whether links we send get previews (`AccountRecord.linkPreviews`), shared with our other devices. */
  async setLinkPreviews(on: boolean): Promise<void> {
    await updateAccountRecord((a) => {
      a.linkPreviews = on;
    });
  },

  /** Whether messages show when they were delivered privately (`AccountRecord.sealedSenderIndicators`), shared with our other devices. */
  async setSealedSenderIndicators(on: boolean): Promise<void> {
    await updateAccountRecord((a) => {
      a.sealedSenderIndicators = on;
    });
  },

  /** Reserve and confirm a Signal username (`nickname` gets a random number, `nickname.42` is taken as typed), then publish it and its link to Storage Service. */
  async setUsername(input: string): Promise<{ username: string; username_link: string }> {
    const previous = (await store.loadValue('usernameLink')) as { entropy: string; serverId: string } | undefined;
    const res = await setAccountUsername(store, httpJson, input, serverUrl(), previous ? fromBase64(previous.entropy) : undefined);
    const serverId = uuidToBytes(res.serverId);
    const link = usernameLinkUrl(res.entropy, serverId);
    await store.storeValue('usernameLink', { entropy: toBase64(res.entropy), serverId: res.serverId });
    host().config.set({ username: res.username, usernameLink: link });
    await updateAccountRecord((a) => {
      a.username = res.username;
      a.usernameLink = create(AccountRecord_UsernameLinkSchema, {
        entropy: res.entropy,
        serverId,
        color: a.usernameLink ? a.usernameLink.color : 0,
      });
    });
    return { username: res.username, username_link: link };
  },

  async deleteUsername(): Promise<void> {
    await deleteAccountUsername(store, httpJson, serverUrl());
    await store.storeValue('usernameLink', undefined);
    host().config.set({ username: '', usernameLink: '' });
    await updateAccountRecord((a) => {
      a.username = '';
      a.usernameLink = undefined;
    });
  },

  async lookupUsername(rawUsername: string): Promise<{ uuid: string; username: string } | null> {
    return resolveSignalUsername(store, httpJson, rawUsername, serverUrl());
  },

  /** Account facts and the server's count of unused one-time PreKeys, for Settings > Debug. Never includes keys or passwords. */
  async diagnostics(): Promise<{
    aci: string;
    pni: string;
    number: string;
    deviceId: number;
    registrationId: number;
    pniRegistrationId: number;
    preKeys: { ec: number; kyber: number } | null;
  }> {
    const acc = await store.getAccount();
    let preKeys: { ec: number; kyber: number } | null = null;
    if (acc) {
      try {
        const res = asObject(await httpJson('GET', '/v2/keys?identity=aci', null, { basicAuth: accountBasicAuth(acc) }));
        preKeys = { ec: Number(res && res.count) || 0, kyber: Number(res && res.pqCount) || 0 };
      } catch (e: any) {
        host().dbg('PreKey count failed: ' + (e && e.message));
      }
    }
    return {
      aci: acc ? acc.aci : '',
      pni: (acc && acc.pni) || '',
      number: (acc && acc.number) || '',
      deviceId: acc ? acc.deviceId : 0,
      registrationId: acc ? acc.registrationId : 0,
      pniRegistrationId: acc ? acc.pniRegistrationId : 0,
      preKeys,
    };
  },
};
