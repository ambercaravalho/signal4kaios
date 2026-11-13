/* Notifications for new messages, calls, and reactions while Beacon is in the background. */

import { S } from '../../strings';
import { config } from '../config';
import { dbg } from '../log';
import { hasServiceWorker } from '../platform';
import type { Conversation, Message } from '../types';
import { displayName, isSelf, isSelfKey } from './contacts';
import { isMuted } from './mute';
import { messageText } from './previews';
import { activeProfile, profileAllows } from './profiles';
import { state } from './state';

export function onNotificationClick(fn: (convId: string) => void): void {
  state.notificationClick = fn;
}

/** What can still notify in a muted chat. Mentions and replies are for groups only. */
export type MutedException = 'mentions' | 'replies' | 'calls';

const OWN_FIELD = { mentions: 'mentionsIfMuted', replies: 'repliesIfMuted', calls: 'callsIfMuted' } as const;
const ACCOUNT_DEFAULT: Record<MutedException, () => boolean> = {
  mentions: () => config.notifyMentionsIfMuted(),
  replies: () => config.notifyRepliesIfMuted(),
  calls: () => config.notifyCallsIfMuted(),
};

/** Whether `kind` still notifies while this chat is muted: its own setting, else the account's default. */
export function notifiesWhileMuted(conv: Conversation, kind: MutedException): boolean {
  if (kind !== 'calls' && conv.type !== 'group') return false;
  const own = conv[OWN_FIELD[kind]];
  return own !== undefined ? own : ACCOUNT_DEFAULT[kind]();
}

/** Why a message might notify: it mentions these ACIs, quotes one of our messages, or is a missed call. */
export interface NotifyReason {
  mentioned?: string[];
  reply?: boolean;
  call?: boolean;
}

function mentionsMe(mentioned: string[] | undefined): boolean {
  const me = config.aci();
  return !!me && !!mentioned && mentioned.indexOf(me) >= 0;
}

/** Whether something new in `conv` should raise a notification while Beacon is in the background: an active notification profile must let it through, then a muted chat only lets its exceptions through. */
export function shouldNotify(conv: Conversation, why: NotifyReason = {}): boolean {
  const profile = activeProfile();
  if (profile && !profileAllows(profile, conv, !!why.call, mentionsMe(why.mentioned))) return false;
  if (!isMuted(conv)) return true;
  if (why.call) return notifiesWhileMuted(conv, 'calls');
  return (mentionsMe(why.mentioned) && notifiesWhileMuted(conv, 'mentions')) || (!!why.reply && notifiesWhileMuted(conv, 'replies'));
}

/** A notification's title and text after the Show setting: everything, the chat's name only, or neither. */
export function notificationText(conv: Conversation, body: string): { title: string; body: string } {
  const show = config.notifyShow();
  if (show === 'none') return { title: 'Beacon', body: S.newMessage };
  return { title: conv.name || 'Beacon', body: show === 'name' ? S.newMessage : body };
}

const shown: Record<string, Notification> = {};

function show(conv: Conversation, text: string): void {
  if (!document.hidden || typeof Notification === 'undefined') return;
  const { title, body } = notificationText(conv, text);
  const opts: NotificationOptions = { body: body.slice(0, 100), tag: conv.id, icon: '/assets/icons/kaios_112.png', data: { convId: conv.id }, silent: !config.notifySound() };

  if (hasServiceWorker() && navigator.serviceWorker) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, opts)).catch((e) => dbg('notify (sw) failed ' + (e && e.message)));
    return;
  }
  try {
    const n = new Notification(title, opts);
    shown[conv.id] = n;
    n.onclick = () => {
      window.focus();
      if (state.notificationClick) state.notificationClick(conv.id);
      n.close();
    };
  } catch (e: any) {
    dbg('notify failed ' + (e && e.message));
  }
}

/** Close the chat's notification, once it was read on another device. */
export function dismissNotifications(convId: string): void {
  const n = shown[convId];
  if (n) {
    delete shown[convId];
    n.close();
  }
  if (!hasServiceWorker() || !navigator.serviceWorker) return;
  navigator.serviceWorker.ready
    .then((reg) => reg.getNotifications({ tag: convId }))
    .then((list) => list.forEach((x) => x.close()))
    .catch((e) => dbg('dismiss notification failed ' + (e && e.message)));
}

export function notify(conv: Conversation, rec: Message, mentioned?: string[]): void {
  const why: NotifyReason = { mentioned, reply: !!rec.quote && isSelf(rec.quote.author), call: !!rec.notice && (rec.notice.kind === 'missedCall' || rec.notice.kind === 'call') };
  if (!shouldNotify(conv, why)) return;
  let body = messageText(rec) || S.newMessage;
  if (conv.type === 'group' && !rec.notice) body = displayName(rec.author) + ': ' + body;
  show(conv, body);
}

/** A call ringing while Beacon is in the background. */
export function notifyIncomingCall(conv: Conversation): void {
  if (shouldNotify(conv, { call: true })) show(conv, S.incomingVoiceCall);
}

/** Someone else reacted to one of our messages; muted chats stay quiet, as in Signal. */
export function notifyReaction(conv: Conversation, reactor: string, emoji: string, target: Message): void {
  if (target.incoming || isSelfKey(reactor) || !config.notifyReactions() || !shouldNotify(conv)) return;
  const line = conv.type === 'group' ? S.nameReactedTo.replace('{name}', displayName(reactor)) : S.reactedTo;
  show(conv, line.replace('{emoji}', emoji).replace('{text}', messageText(target) || S.yourMessage));
}
