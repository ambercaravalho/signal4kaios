/* Notification profiles from the phone, like Signal-Desktop's types/NotificationProfile: which one is on now, through the manual switch or its schedule, and which chats it lets through. */

import type { HostNotificationProfile } from '../../../engine/host';
import { signal } from '../api';
import { config } from '../config';
import { dbg } from '../log';
import type { Conversation } from '../types';
import { altKeyOf } from './contacts';

export type NotificationProfile = HostNotificationProfile;

/** Monday is 1 and Sunday 7, as in `NotificationProfile.DayOfWeek`. */
function weekday(d: Date): number {
  return d.getDay() || 7;
}

function at(day: Date, clock: number): number {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(clock / 100), clock % 100).getTime();
}

/** When the scheduled stretch covering `now` began, or 0 when the schedule isn't on. A stretch that ends before it starts runs past midnight. */
export function scheduleStart(p: NotificationProfile, now: number): number {
  const s = p.schedule;
  if (!s || !s.days.length || s.start === s.end) return 0;
  const d = new Date(now);
  const clock = d.getHours() * 100 + d.getMinutes();
  const today = weekday(d);
  if (s.start < s.end) return s.days.indexOf(today) >= 0 && clock >= s.start && clock < s.end ? at(d, s.start) : 0;
  if (clock >= s.start && s.days.indexOf(today) >= 0) return at(d, s.start);
  const yesterday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  return clock < s.end && s.days.indexOf(weekday(yesterday)) >= 0 ? at(yesterday, s.start) : 0;
}

/** The profile on at `now`: one switched on by hand, else the scheduled one that started last, unless everything was switched off since it started. */
export function activeProfile(now = Date.now()): NotificationProfile | null {
  const profiles = config.notificationProfiles();
  if (!profiles.length) return null;
  const o = config.notificationProfileOverride();
  if (o && 'enabledId' in o && (!o.endAt || o.endAt > now)) {
    const manual = profiles.find((p) => p.id === o.enabledId);
    if (manual) return manual;
  }
  const offSince = o && 'disabledAt' in o ? o.disabledAt : 0;
  let best: NotificationProfile | null = null;
  let bestStart = 0;
  for (const p of profiles) {
    const start = scheduleStart(p, now);
    if (start && start > offSince && start > bestStart) {
      best = p;
      bestStart = start;
    }
  }
  return best;
}

/** Whether `p` lets something from `conv` through: an allowed chat, or any call or mention when the profile allows those. */
export function profileAllows(p: NotificationProfile, conv: Conversation, call: boolean, mentionsMe: boolean): boolean {
  if ((call && p.allowAllCalls) || (mentionsMe && p.allowAllMentions)) return true;
  const alt = altKeyOf(conv.id);
  return p.allowed.indexOf(conv.id) >= 0 || (!!alt && p.allowed.indexOf(alt) >= 0);
}

/** Switch `id` on until `endAt` (0 until switched off), or every profile off with null; kept on the account's other devices too. */
export function setProfileOverride(id: string | null, endAt = 0): void {
  const override = id ? { enabledId: id, endAt } : { disabledAt: Date.now() };
  config.set({ notificationProfileOverride: override });
  signal.setNotificationProfileOverride(override).catch((e) => dbg('profile switch sync failed: ' + (e && e.message)));
}
