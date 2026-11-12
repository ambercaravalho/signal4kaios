/* Opening Signal links inside Beacon: groups, proxies, usernames, and phone numbers, from a scanned code or a link in a chat. */

import { router } from '../app/router';
import { alertDialog } from '../components/Overlays';
import { toast } from '../components/Toast';
import { signal } from '../data/api';
import { signalLink } from '../data/links';
import * as store from '../data/store';
import { friendlyError } from '../errors';
import { fmt, S } from '../strings';
import { ChatScreen, openChat as pushChat } from './Chat';
import { JoinGroupScreen } from './JoinGroup';
import { askUseProxy } from './Proxy';

function openChat(convId: string, replace: boolean): void {
  if (replace) router.replace(ChatScreen, { convId });
  else pushChat(convId);
}

/** Open the chat with a number: a synced contact right away, anyone else after a contact discovery lookup. */
export async function openPhone(number: string, replace = false): Promise<void> {
  const c = store.contactsList().find((x) => x.number === number && !!x.uuid);
  if (c) {
    openChat(store.conversationWith(c).id, replace);
    return;
  }
  toast(S.lookingUp);
  try {
    const res = await signal.lookupNumber(number);
    if (res && res.uuid) openChat(store.conversationWith({ uuid: res.uuid, number: res.number }).id, replace);
    else alertDialog(S.phoneNotFound, S.phoneNotFoundBody);
  } catch (e) {
    const wait = e && (e as { retryAfterSeconds?: number }).retryAfterSeconds;
    toast(typeof wait === 'number' ? fmt(S.phoneLookupLimited, { n: Math.max(1, Math.ceil(wait / 60)) }) : friendlyError(e));
  }
}

async function openUsernameLink(url: string, replace: boolean): Promise<void> {
  toast(S.lookingUp);
  try {
    const res = await signal.lookupUsernameLink(url);
    if (res && res.uuid) openChat(store.conversationWith({ uuid: res.uuid, name: '@' + res.username }).id, replace);
    else alertDialog(S.usernameLinkGone, S.usernameLinkGoneBody);
  } catch (e) {
    toast(friendlyError(e));
  }
}

/** Handle a Signal link in Beacon; false when the text isn't one. `replace` swaps the current screen for the chat it opens. */
export function openSignalLink(text: string, replace = false): boolean {
  const link = signalLink(text);
  if (!link) return false;
  if (link.kind === 'phone') void openPhone(link.number, replace);
  else if (link.kind === 'group') router.push(JoinGroupScreen, { url: link.url });
  else if (link.kind === 'proxy') void askUseProxy(link.url);
  else void openUsernameLink(link.url, replace);
  return true;
}
