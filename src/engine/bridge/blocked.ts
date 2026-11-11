/* Blocked people and groups: the cached sets incoming messages are checked against, and the Blocked sync our other devices get. */

import { fromBase64, toBase64 } from '../bytes';
import { ContentSchema, type Content } from '../gen/SignalService_pb';
import { create, isAci } from '../net/proto';
import type { IncomingEnvelope } from '../net/receive';
import { deriveGroupV2Keys } from '../services/groups-v2';
import { client } from './context';
import { syncedContacts, syncedGroups } from './contacts';

interface BlockedSets {
  acis: Set<string>;
  numbers: Set<string>;
  groups: Set<string>;
}

let blockedCache: Promise<BlockedSets> | null = null;

/** Blocked people and groups from `syncedContacts` / `syncedGroups`, cached until `invalidateBlocked()`. */
function blockedSets(): Promise<BlockedSets> {
  if (!blockedCache) {
    blockedCache = (async () => {
      const out: BlockedSets = { acis: new Set(), numbers: new Set(), groups: new Set() };
      for (const c of await syncedContacts()) {
        if (!c.blocked) continue;
        if (isAci(c.uuid)) out.acis.add(c.uuid);
        if (c.number) out.numbers.add(c.number);
      }
      for (const g of await syncedGroups()) if (g.blocked && g.internal_id) out.groups.add(g.internal_id);
      return out;
    })();
    blockedCache.catch(() => {
      blockedCache = null;
    });
  }
  return blockedCache;
}

export function invalidateBlocked(): void {
  blockedCache = null;
}

function groupIdOf(mk: Uint8Array | undefined): string {
  if (!mk || mk.length !== 32) return '';
  try {
    return deriveGroupV2Keys(mk).internalId;
  } catch {
    return '';
  }
}

/** Whether an incoming message, edit, typing indicator, receipt, or call comes from a blocked person or a blocked group. */
export async function isFromBlocked(env: IncomingEnvelope, content: Content): Promise<boolean> {
  const b = await blockedSets();
  if (b.acis.size === 0 && b.numbers.size === 0 && b.groups.size === 0) return false;
  if (env.sourceUuid && b.acis.has(env.sourceUuid)) return true;
  if (env.sourceE164 && b.numbers.has(env.sourceE164)) return true;
  const c = content.content;
  let groupId = '';
  if (c.case === 'dataMessage') groupId = groupIdOf(c.value.groupV2 && c.value.groupV2.masterKey);
  else if (c.case === 'editMessage') groupId = groupIdOf(c.value.dataMessage && c.value.dataMessage.groupV2 && c.value.dataMessage.groupV2.masterKey);
  else if (c.case === 'typingMessage' && c.value.groupId.length) groupId = toBase64(c.value.groupId);
  return !!groupId && b.groups.has(groupId);
}

export async function isBlockedRecipient(recipient: string): Promise<boolean> {
  const b = await blockedSets();
  if (recipient.startsWith('group.')) return b.groups.has(recipient.replace(/^group\./, ''));
  return b.acis.has(recipient) || b.numbers.has(recipient);
}

/** The full blocked list for our other devices, as Signal-Desktop sends after every block or unblock. */
export async function sendBlockedSync(): Promise<void> {
  const b = await blockedSets();
  await client.sendSyncMessage(
    create(ContentSchema, {
      content: {
        case: 'syncMessage',
        value: {
          content: {
            case: 'blocked',
            value: {
              acis: Array.from(b.acis),
              numbers: Array.from(b.numbers),
              groupIds: Array.from(b.groups).map((g) => fromBase64(g)),
            },
          },
        },
      },
    })
  );
}
