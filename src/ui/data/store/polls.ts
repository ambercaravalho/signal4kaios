/* Polls: votes, ending, and sending. */

import { S } from '../../strings';
import { signal } from '../api';
import { db } from '../db';
import type { StoreEvent } from '../normalize';
import type { Conversation, Message, Poll, PollVote } from '../types';
import { authorKeys, personKey, self } from './contacts';
import { emit } from './events';
import { applyNotice, enqueueMutation, updateTarget } from './ingest';
import { previewOf } from './previews';
import { basePayload, convForSend, newOutgoingRec, sendCore, type SendPayload } from './send';
import { convs } from './state';

/** How many people chose each option. */
export function pollCounts(poll: Poll): number[] {
  const counts = poll.options.map(() => 0);
  for (const v of Object.values(poll.votes || {})) for (const i of v.options) if (i < counts.length) counts[i] += 1;
  return counts;
}

/** Signal-Desktop's handlePollVote: a person's vote with a higher voteCount replaces their last one; our own other devices also win ties when newer. */
export function applyPollVote(ev: Extract<StoreEvent, { type: 'pollVote' }>): void {
  const voter = personKey(ev.voter);
  updateTarget(ev.convId, ev.targetTimestamp, authorKeys(ev.targetAuthor), 'poll vote', (rec) => {
    const p = rec.poll;
    if (!p || p.ended || rec.deleted) return;
    const opts = ev.options;
    if (opts.some((i) => i >= p.options.length) || opts.some((i, n) => opts.indexOf(i) !== n) || (!p.allowMultiple && opts.length > 1)) return;
    const cur = p.votes[voter];
    if (cur && !(ev.voteCount > cur.voteCount || (voter === self() && ev.voteCount === cur.voteCount && ev.timestamp > cur.timestamp))) return;
    p.votes[voter] = { options: opts.slice(), voteCount: ev.voteCount, timestamp: ev.timestamp };
  });
}

/** Only the poll's author can end it, so the poll is looked up under the sender as its author. */
export function applyPollEnd(ev: Extract<StoreEvent, { type: 'pollEnd' }>): void {
  updateTarget(ev.convId, ev.targetTimestamp, authorKeys(ev.author), 'poll end', (rec) => {
    const p = rec.poll;
    if (!p || p.ended || rec.deleted) return;
    p.ended = true;
    const conv = convs[rec.convId];
    applyNotice({ type: 'notice', convId: rec.convId, groupInternalId: (conv && conv.groupInternalId) || null, author: ev.author, timestamp: ev.timestamp, notice: { kind: 'pollEnded', text: p.question } }, true);
  });
}

/** Start a poll in a group; Signal-Desktop doesn't send polls in 1:1 chats yet. */
export function sendPoll(convId: string, question: string, options: string[], allowMultiple: boolean): Promise<Message> {
  let conv: Conversation;
  try {
    conv = convForSend(convId);
  } catch (e) {
    return Promise.reject(e);
  }
  if (conv.type !== 'group') return Promise.reject(new Error('Polls only work in groups'));
  const rec = newOutgoingRec(conv, { poll: { question, options, allowMultiple, votes: {} } });
  const payload: SendPayload = { ...basePayload(conv, ''), poll: { question, options, allow_multiple: allowMultiple } };
  return sendCore(conv, rec, payload, previewOf(rec));
}

/** Vote (or, with no options, take our vote back); the vote shows at once and is undone if it can't be sent. */
export async function votePoll(rec: Message, options: number[]): Promise<void> {
  const conv = convs[rec.convId];
  if (!conv || !conv.sendId || !rec.poll) throw new Error('group not ready');
  const me = self();
  let prev: PollVote | undefined;
  let vote: PollVote | undefined;
  await enqueueMutation(async () => {
    const fresh = await db.getMessage(rec.id);
    if (!fresh || !fresh.poll || fresh.poll.ended) return;
    prev = fresh.poll.votes[me];
    vote = { options: options.slice(), voteCount: (prev ? prev.voteCount : 0) + 1, timestamp: Date.now() };
    fresh.poll.votes[me] = vote;
    await db.putMessage(fresh);
    emit('message-updated', fresh, undefined);
  });
  if (!vote) throw new Error(S.pollEnded);
  const sent = vote;
  await signal.sendPollVote(conv.sendId, rec.incoming ? rec.author : me, rec.timestamp, options, sent.voteCount).catch((err) => {
    enqueueMutation(async () => {
      const fresh = await db.getMessage(rec.id);
      const now = fresh && fresh.poll && fresh.poll.votes[me];
      if (!fresh || !fresh.poll || !now || now.timestamp !== sent.timestamp) return;
      if (prev) fresh.poll.votes[me] = prev;
      else delete fresh.poll.votes[me];
      await db.putMessage(fresh);
      emit('message-updated', fresh, undefined);
    });
    throw err;
  });
}

/** End our own poll for everyone. */
export async function endPoll(rec: Message): Promise<void> {
  const conv = convs[rec.convId];
  if (!conv || !conv.sendId || !rec.poll || rec.incoming) throw new Error('group not ready');
  const ts = await signal.sendPollTerminate(conv.sendId, rec.timestamp);
  applyPollEnd({ type: 'pollEnd', convId: rec.convId, author: self(), targetTimestamp: rec.timestamp, timestamp: ts });
}
