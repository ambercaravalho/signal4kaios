/* Who a send goes to (a person or a group's members), delivering content to them, and the sent sync for our other devices. */

import type { MessageInitShape } from '@bufbuild/protobuf';

import { fromBase64 } from '../bytes';
import {
  AddressableMessageSchema,
  type Content,
  ContentSchema,
  ConversationIdentifierSchema,
  type DataMessage,
  DataMessageSchema,
} from '../gen/SignalService_pb';
import { host } from '../host';
import type { SenderKeyGroup } from '../net/client';
import { create } from '../net/proto';
import { endorsesAll, loadGroupSendEndorsements } from '../services/group-send';
import { buildGroupContextV2, deriveGroupV2Keys } from '../services/groups-v2';
import { client, store } from './context';
import { contactIds, resolveAci, resolveRecipients } from './contacts';
import { refreshGroup, resolveGroupRecipients } from './group-state';

export type DataMessageInit = MessageInitShape<typeof DataMessageSchema>;
export type AddressableMessageInit = MessageInitShape<typeof AddressableMessageSchema>;
export type ConversationIdentifierInit = MessageInitShape<typeof ConversationIdentifierSchema>;

/** A message as the app names it: its author (number or ACI) and sent time. */
export interface MessageRef {
  author: string;
  timestamp: number;
}

export interface SendTarget {
  isGroup: boolean;
  peers: string[];
  groupV2?: DataMessage['groupV2'];
  internalId: string;
}

export function dataContent(dm: DataMessageInit): Content {
  return create(ContentSchema, { content: { case: 'dataMessage', value: dm } });
}

export function syncSent(destination: string, ts: number, dm: DataMessageInit, editTimestamp?: number): Content {
  return create(ContentSchema, {
    content: {
      case: 'syncMessage',
      value: {
        content: {
          case: 'sent',
          value: {
            destinationServiceId: destination || undefined,
            timestamp: BigInt(ts),
            message: editTimestamp ? undefined : dm,
            editMessage: editTimestamp ? { targetSentTimestamp: BigInt(editTimestamp), dataMessage: dm } : undefined,
          },
        },
      },
    },
  });
}

export async function groupTargets(recipient: string): Promise<SendTarget> {
  if (!recipient.startsWith('group.')) {
    return { isGroup: false, peers: await resolveRecipients([recipient]), internalId: '' };
  }
  const grp = await resolveGroupRecipients(recipient);
  const groupV2 = buildGroupContextV2({ masterKey: grp.masterKey, revision: grp.revision });
  if (!groupV2) throw new Error('This group has no Groups V2 master key; legacy groups are not supported');
  return { isGroup: true, peers: grp.members, groupV2, internalId: grp.internalId };
}

/** Our own ACI when `author` is us (by number or ACI), else theirs from the synced contacts; throws when unknown. */
export async function authorAci(author: string): Promise<string> {
  const acc = await store.getAccount();
  const aci = acc && (author === acc.number || author === acc.aci) ? acc.aci : await resolveAci(author);
  if (!aci) throw new Error('No Signal account known for ' + author);
  return aci;
}

const ENDORSEMENT_REFRESH_MS = 10 * 60 * 1000;
const endorsementRefreshedAt = new Map<string, number>();

/** A group's Sender Key send details. Endorsements that are missing, expiring, or don't cover every member are refetched with the group, at most every 10 minutes. */
async function senderKeyGroup(internalId: string, masterKey: Uint8Array, members: string[]): Promise<SenderKeyGroup> {
  let endorsements = await loadGroupSendEndorsements(store, internalId);
  if (!endorsesAll(endorsements, members) && Date.now() - (endorsementRefreshedAt.get(internalId) || 0) > ENDORSEMENT_REFRESH_MS) {
    endorsementRefreshedAt.set(internalId, Date.now());
    try {
      await refreshGroup(masterKey);
      endorsements = await loadGroupSendEndorsements(store, internalId);
    } catch (e: any) {
      host().dbg('group refresh for endorsements failed: ' + (e && e.message));
    }
  }
  return { internalId, secretParams: deriveGroupV2Keys(masterKey).secretParams, endorsements };
}

/** Resolves to whether every recipient got it sealed. */
export async function deliver(target: SendTarget, content: Content, ts: number, online = false): Promise<boolean> {
  if (target.isGroup) {
    const group = target.groupV2 && target.internalId ? await senderKeyGroup(target.internalId, target.groupV2.masterKey, target.peers) : undefined;
    return client.sendGroupContent(target.peers, content, ts, online, group);
  }
  let sealed = target.peers.length > 0;
  for (const peer of target.peers) if (!(await client.sendContentToRecipient(peer, content, ts, online))) sealed = false;
  return sealed;
}

/**
 * Send a data message to `recipient` (a person or a `group.` send ID) and a sent sync to our other devices. `build` adds the message's fields; its timestamp and group context are filled in. `groupOnly` is the error for a recipient that isn't a group; `editTimestamp` sends it as an edit of that message.
 */
export async function sendDataMessage(
  recipient: string,
  build: (target: SendTarget) => DataMessageInit | Promise<DataMessageInit>,
  opts: { groupOnly?: string; editTimestamp?: number } = {}
): Promise<{ timestamp: number; sealed: boolean; dm: DataMessageInit }> {
  const ts = Date.now();
  const target = await groupTargets(recipient);
  if (opts.groupOnly && !target.isGroup) throw new Error(opts.groupOnly);
  const dm: DataMessageInit = { timestamp: BigInt(ts), groupV2: target.groupV2, ...(await build(target)) };
  const content = opts.editTimestamp
    ? create(ContentSchema, { content: { case: 'editMessage', value: { targetSentTimestamp: BigInt(opts.editTimestamp), dataMessage: dm } } })
    : dataContent(dm);
  const sealed = await deliver(target, content, ts);
  await client.sendSyncMessage(syncSent(target.isGroup ? '' : target.peers[0], ts, dm, opts.editTimestamp), ts);
  return { timestamp: ts, sealed, dm };
}

/** A chat as sync messages name it, from its send ID: the group ID, else the person's ACI, else their number. */
export async function conversationIdentifier(sendId: string): Promise<ConversationIdentifierInit | null> {
  if (sendId.startsWith('group.')) {
    const id = fromBase64(sendId.replace(/^group\./, ''));
    return id.length ? { identifier: { case: 'threadGroupId', value: id } } : null;
  }
  const ids = await contactIds(sendId);
  if (ids.aci) return { identifier: { case: 'threadServiceId', value: ids.aci } };
  if (ids.e164) return { identifier: { case: 'threadE164', value: ids.e164 } };
  return null;
}

export async function addressableMessages(refs: MessageRef[]): Promise<AddressableMessageInit[]> {
  const acc = await store.getAccount();
  const out: AddressableMessageInit[] = [];
  for (const r of refs) {
    const mine = !!acc && (r.author === acc.number || r.author === acc.aci);
    const aci = mine ? acc!.aci : await resolveAci(r.author);
    const sentTimestamp = BigInt(r.timestamp);
    if (aci) out.push({ author: { case: 'authorServiceId', value: aci }, sentTimestamp });
    else if (r.author.startsWith('+')) out.push({ author: { case: 'authorE164', value: r.author }, sentTimestamp });
  }
  return out;
}
