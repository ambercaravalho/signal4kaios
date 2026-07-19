/* Minimal, defensive envelope parse for building a push notification. This
   MIRRORS the conversation-id rules in app/js/normalize.js (group -> "g:"+id,
   otherwise sourceNumber || sourceUuid || source) so a notification click opens
   the right conversation. It intentionally only fires for incoming user
   messages; typing/receipts/reactions/syncs return null. Never throws. */

export interface Note {
  title: string;
  body: string;
  convId: string;
  incoming: boolean;
}

const MAX_BODY = 140;

function trunc(s: string): string {
  return s.length > MAX_BODY ? s.slice(0, MAX_BODY - 1) + '\u2026' : s;
}

export function toNote(text: string): Note | null {
  let frame: any;
  try {
    frame = JSON.parse(text);
  } catch {
    return null;
  }
  const env = frame && frame.envelope;
  if (!env) return null;

  // Only top-level incoming dataMessages are user messages; sent syncs, typing,
  // receipts, and read syncs are not notification-worthy here.
  const dm = env.dataMessage;
  if (!dm) return null;
  if (dm.reaction || dm.remoteDelete || dm.pinMessage || dm.unpinMessage) return null;

  const hasBody = dm.message != null && dm.message !== '';
  const hasAttach = Array.isArray(dm.attachments) && dm.attachments.length > 0;
  if (!hasBody && !hasAttach && !dm.sticker) return null;

  const gi = dm.groupInfo;
  const convId = gi && gi.groupId
    ? 'g:' + gi.groupId
    : (env.sourceNumber || env.sourceUuid || env.source || '');
  if (!convId) return null;

  const sender = env.sourceName || env.sourceNumber || env.sourceUuid ||
    env.source || 'Signal';
  let body: string;
  if (hasBody) body = String(dm.message);
  else if (hasAttach) body = '[attachment]';
  else body = '[sticker]';

  if (gi && gi.groupId) {
    return { title: 'New group message', body: trunc(sender + ': ' + body), convId: convId, incoming: true };
  }
  return { title: sender, body: trunc(body), convId: convId, incoming: true };
}
