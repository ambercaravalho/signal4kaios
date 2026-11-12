/* Notification profiles (Storage record type 9) and the account's manual override, read and written the way Signal-Desktop's storageRecordOps does. */

import type { MessageInitShape } from '@bufbuild/protobuf';

import { fromBase64, toBase64 } from '../../bytes';
import {
  type AccountRecord_NotificationProfileManualOverride,
  AccountRecord_NotificationProfileManualOverrideSchema,
  type NotificationProfile,
  NotificationProfile_DayOfWeek,
  type Recipient,
} from '../../gen/SignalStorage_pb';
import type { HostNotificationProfile, HostProfileOverride } from '../../host';
import { create, num, serviceIdFrom } from '../../net/proto';
import { groupIdFromMasterKey } from '../groups-v2';

const MAX_NAME = 64;
const MAX_ALLOWED = 500;

function clockTime(v: number): number {
  const h = Math.floor(v / 100);
  const m = v % 100;
  return h >= 0 && h < 24 && m >= 0 && m < 60 ? v : 0;
}

function recipientKeys(r: Recipient): string[] {
  const id = r.identifier;
  if (id.case === 'contact') {
    const aci = serviceIdFrom(id.value.serviceId, id.value.serviceIdBinary);
    return [aci, id.value.e164].filter(Boolean) as string[];
  }
  if (id.case === 'groupMasterKey' && id.value.length === 32) return ['g:' + groupIdFromMasterKey(id.value)];
  return [];
}

/** A profile as the app uses it; null once it's deleted. */
export function readNotificationProfile(p: NotificationProfile): HostNotificationProfile | null {
  if (p.deletedAtTimestampMs > 0n || p.id.length === 0) return null;
  const days = p.scheduleDaysEnabled.map((d) => (d === NotificationProfile_DayOfWeek.UNKNOWN ? NotificationProfile_DayOfWeek.MONDAY : d)).filter((d) => d >= 1 && d <= 7);
  return {
    id: toBase64(p.id),
    name: p.name.slice(0, MAX_NAME),
    emoji: (p.emoji || '').slice(0, 8),
    createdAt: num(p.createdAtMs),
    allowAllCalls: p.allowAllCalls,
    allowAllMentions: p.allowAllMentions,
    allowed: p.allowedMembers.slice(0, MAX_ALLOWED).flatMap(recipientKeys),
    schedule: p.scheduleEnabled ? { start: clockTime(p.scheduleStartTime), end: clockTime(p.scheduleEndTime), days } : null,
  };
}

export function readProfileOverride(o: AccountRecord_NotificationProfileManualOverride | undefined): HostProfileOverride {
  if (!o) return null;
  if (o.override.case === 'disabledAtTimestampMs') return { disabledAt: num(o.override.value) };
  if (o.override.case === 'enabled' && o.override.value.id.length) return { enabledId: toBase64(o.override.value.id), endAt: num(o.override.value.endAtTimestampMs) };
  return null;
}

/** The record field for an override: `enabledId` on until `endAt` (0 until turned off), or everything off from `disabledAt`. */
export function profileOverrideRecord(o: NonNullable<HostProfileOverride>): AccountRecord_NotificationProfileManualOverride {
  const init: MessageInitShape<typeof AccountRecord_NotificationProfileManualOverrideSchema> =
    'enabledId' in o
      ? { override: { case: 'enabled', value: { id: fromBase64(o.enabledId), endAtTimestampMs: BigInt(Math.max(0, Math.floor(o.endAt))) } } }
      : { override: { case: 'disabledAtTimestampMs', value: BigInt(Math.max(0, Math.floor(o.disabledAt))) } };
  return create(AccountRecord_NotificationProfileManualOverrideSchema, init);
}
