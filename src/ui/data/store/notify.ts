/* Notifications for new messages while Beacon is in the background. */

import { config } from '../config';
import { dbg } from '../log';
import { hasServiceWorker } from '../platform';
import type { Conversation, Message } from '../types';
import { displayName } from './contacts';
import { messageText } from './previews';
import { state } from './state';

export function onNotificationClick(fn: (convId: string) => void): void {
  state.notificationClick = fn;
}

/** Whether a mention of us still notifies while this group is muted: its own setting, else the account's default. */
export function mentionsNotifyWhileMuted(conv: Conversation): boolean {
  return conv.type === 'group' && (conv.mentionsIfMuted !== undefined ? conv.mentionsIfMuted : config.notifyMentionsIfMuted());
}

function mentionsMe(mentioned: string[] | undefined): boolean {
  const me = config.aci();
  return !!me && !!mentioned && mentioned.indexOf(me) >= 0;
}

/** Whether a new message in `conv` should raise a notification while Beacon is in the background. */
export function shouldNotify(conv: Conversation, mentioned?: string[]): boolean {
  return !conv.muted || (mentionsMe(mentioned) && mentionsNotifyWhileMuted(conv));
}

export function notify(conv: Conversation, rec: Message, mentioned?: string[]): void {
  if (!shouldNotify(conv, mentioned) || !document.hidden || typeof Notification === 'undefined') return;
  const title = conv.name || 'Beacon';
  let body = messageText(rec) || 'New message';
  if (conv.type === 'group' && !rec.notice) body = displayName(rec.author) + ': ' + body;
  const opts: NotificationOptions = { body: body.slice(0, 100), tag: conv.id, icon: '/assets/icons/kaios_112.png', data: { convId: conv.id } };

  if (hasServiceWorker() && navigator.serviceWorker) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, opts)).catch((e) => dbg('notify (sw) failed ' + (e && e.message)));
    return;
  }
  try {
    const n = new Notification(title, opts);
    n.onclick = () => {
      window.focus();
      if (state.notificationClick) state.notificationClick(conv.id);
      n.close();
    };
  } catch (e: any) {
    dbg('notify failed ' + (e && e.message));
  }
}
