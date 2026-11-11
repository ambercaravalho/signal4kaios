/* Sender Key group sends: each group's group send endorsements (from the storage server) and our sender key state for it (distribution ID and which member devices hold the key). Follows Signal-Desktop's groupSendEndorsements.preload.ts and sendToGroup.preload.ts. */

import { bytesToUuid, randomBytes, toBase64 } from '../bytes';
import { libsignal } from '../protocol/libsignal';
import type { SignalProtocolStore } from '../protocol/store';

const TWO_HOURS = 2 * 3600;
const TWO_DAYS = 2 * 86400;
/** Signal-Desktop's MAX_SENDER_KEY_EXPIRE_DURATION: a sender key older than this is replaced. */
const SENDER_KEY_MAX_AGE_MS = 90 * 86400 * 1000;

/** Endorsements for one group's members, valid until `expiration` (epoch seconds). */
export interface GroupSendEndorsements {
  expiration: number;
  members: Record<string, Uint8Array>;
}

const endorsementKey = (internalId: string) => 'groupSendEndorsements:' + internalId;
const senderKeyKey = (internalId: string) => 'senderKeyInfo:' + internalId;

/** Verify a `GroupSendEndorsementsResponse` for the group's full members (ours included) and keep it for later sends. */
export async function storeGroupSendEndorsements(
  store: SignalProtocolStore,
  internalId: string,
  secretParams: Uint8Array,
  serverPublicParams: Uint8Array,
  response: Uint8Array,
  memberAcis: string[],
  nowMs = Date.now()
): Promise<GroupSendEndorsements | null> {
  if (!response.length || !memberAcis.length) return null;
  const res = libsignal.groupSendEndorsementsReceive(serverPublicParams, secretParams, response, memberAcis, Math.floor(nowMs / 1000)) as {
    expiration: number;
    endorsements: Uint8Array[];
  };
  if (res.endorsements.length !== memberAcis.length) throw new Error('Storage server returned the wrong number of endorsements');
  const members: Record<string, Uint8Array> = {};
  memberAcis.forEach((aci, i) => {
    members[aci] = res.endorsements[i];
  });
  const out = { expiration: res.expiration, members };
  await store.storeValue(endorsementKey(internalId), out);
  return out;
}

/** The kept endorsements, or null when there are none or they expire within two hours (or implausibly far out), as Signal-Desktop's validateGroupSendEndorsementsExpiration. */
export async function loadGroupSendEndorsements(store: SignalProtocolStore, internalId: string, nowMs = Date.now()): Promise<GroupSendEndorsements | null> {
  const e = (await store.loadValue(endorsementKey(internalId))) as GroupSendEndorsements | undefined;
  if (!e || typeof e.expiration !== 'number' || !e.members) return null;
  const left = e.expiration - Math.floor(nowMs / 1000);
  return left > TWO_HOURS && left < TWO_DAYS ? e : null;
}

/** True when the endorsements cover every one of `acis`. */
export function endorsesAll(e: GroupSendEndorsements | null, acis: string[]): boolean {
  return !!e && acis.every((a) => !!e.members[a]);
}

/** Base64 `Group-Send-Token` for sending to `acis`, each of which must have an endorsement. */
export function groupSendToken(e: GroupSendEndorsements, secretParams: Uint8Array, acis: string[]): string {
  const list = acis.map((a) => {
    const endorsement = e.members[a];
    if (!endorsement) throw new Error('No group send endorsement for a recipient');
    return endorsement;
  });
  return toBase64(libsignal.groupSendToken(secretParams, list, e.expiration));
}

/** A member device that already holds our sender key, with the registration ID it had then. */
export interface SenderKeyDevice {
  aci: string;
  deviceId: number;
  registrationId: number;
}

export interface SenderKeyInfo {
  distributionId: string;
  createdAt: number;
  memberDevices: SenderKeyDevice[];
}

function newDistributionId(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return bytesToUuid(b);
}

/** Our sender key state for a group, started fresh (new distribution ID) when there is none or it is older than 90 days. */
export async function loadSenderKeyInfo(store: SignalProtocolStore, internalId: string, nowMs = Date.now()): Promise<SenderKeyInfo> {
  const info = (await store.loadValue(senderKeyKey(internalId))) as SenderKeyInfo | undefined;
  if (info && typeof info.distributionId === 'string' && Array.isArray(info.memberDevices) && nowMs - info.createdAt < SENDER_KEY_MAX_AGE_MS) return info;
  return rotateSenderKey(store, internalId, nowMs);
}

export async function saveSenderKeyInfo(store: SignalProtocolStore, internalId: string, info: SenderKeyInfo): Promise<void> {
  await store.storeValue(senderKeyKey(internalId), info);
}

/** Start a new sender key under a new distribution ID, so members who left can't read what we send next. */
export async function rotateSenderKey(store: SignalProtocolStore, internalId: string, nowMs = Date.now()): Promise<SenderKeyInfo> {
  const info: SenderKeyInfo = { distributionId: newDistributionId(), createdAt: nowMs, memberDevices: [] };
  await saveSenderKeyInfo(store, internalId, info);
  return info;
}

const sameDevice = (a: SenderKeyDevice, b: SenderKeyDevice) => a.aci === b.aci && a.deviceId === b.deviceId && a.registrationId === b.registrationId;

/** Signal-Desktop's _analyzeSenderKeyDevices: which devices still need our sender key, and which no longer get messages. */
export function analyzeSenderKeyDevices(
  memberDevices: SenderKeyDevice[],
  devicesForSend: SenderKeyDevice[]
): { newDevices: SenderKeyDevice[]; newAcis: string[]; removedDevices: SenderKeyDevice[]; removedAcis: string[] } {
  const newDevices = devicesForSend.filter((d) => !memberDevices.some((m) => sameDevice(m, d)));
  const removedDevices = memberDevices.filter((m) => !devicesForSend.some((d) => sameDevice(m, d)));
  const acis = (list: SenderKeyDevice[]) => Array.from(new Set(list.map((d) => d.aci)));
  return { newDevices, newAcis: acis(newDevices), removedDevices, removedAcis: acis(removedDevices) };
}