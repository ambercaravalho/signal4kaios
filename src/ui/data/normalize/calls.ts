/* Call lines: the calls made on this phone, and the call log our other devices sync. Only 1:1 voice calls get lines; video, group, and call link events keep their old handling. */

import { isUuid } from '../../../engine/validate';
import { dbg } from '../log';
import type { CallDirection, CallOutcome } from '../types';
import type { StoreEvent } from './events';
import { num, str } from './fields';

const DIRECTIONS: CallDirection[] = ['incoming', 'outgoing'];
const OUTCOMES: CallOutcome[] = ['accepted', 'declined', 'missed', 'unanswered'];
/** A day, longer than any call Signal lets ring and talk for. */
const MAX_DURATION_MS = 86_400_000;

function callId(v: unknown): string {
  const id = str(v);
  return /^\d{1,20}$/.test(id) ? id : '';
}

/** The line for a call this phone rang or placed, which the engine sends when the call ends. */
export function callRecordEvents(env: any): StoreEvent[] {
  const r = env.callRecord;
  const peer = str(env.sourceUuid);
  const id = callId(r && r.callId);
  const direction = str(r && r.direction) as CallDirection;
  const outcome = str(r && r.outcome) as CallOutcome;
  if (!isUuid(peer) || !id || DIRECTIONS.indexOf(direction) < 0 || OUTCOMES.indexOf(outcome) < 0) {
    dbg('normalize: bad call record');
    return [];
  }
  const durationMs = Math.min(MAX_DURATION_MS, Math.max(0, num(r.durationMs)));
  return [{ type: 'call', chat: { key: peer }, callId: id, direction, outcome, timestamp: num(env.timestamp) || Date.now(), durationMs }];
}

/** `SyncMessage.callEvent` and `callLogEvent` from our other devices. An answered or declined call there updates its line here; we never hear about calls they missed, which ring here too. */
export function callSyncEvents(sm: any): StoreEvent[] {
  const out: StoreEvent[] = [];
  const e = sm.callEvent;
  if (e && typeof e === 'object' && e.type === 'audio' && isUuid(str(e.peer)) && callId(e.callId)) {
    const chat = { key: str(e.peer) };
    const direction = str(e.direction) as CallDirection;
    if (e.event === 'delete') out.push({ type: 'callDelete', chat, callId: callId(e.callId) });
    else if ((e.event === 'accepted' || e.event === 'notAccepted') && DIRECTIONS.indexOf(direction) >= 0) {
      const outcome: CallOutcome = e.event === 'accepted' ? 'accepted' : direction === 'incoming' ? 'declined' : 'unanswered';
      out.push({ type: 'call', chat, callId: callId(e.callId), direction, outcome, timestamp: num(e.timestamp) || Date.now(), durationMs: 0 });
    }
  }
  const l = sm.callLogEvent;
  if (l && typeof l === 'object') {
    const type = str(l.type);
    const inChat = type === 'readInConversation' || type === 'clearInConversation';
    const action = type === 'read' || type === 'readInConversation' ? 'read' : type === 'clear' || type === 'clearInConversation' ? 'clear' : null;
    if (action && (!inChat || isUuid(str(l.peer)))) out.push({ type: 'callLog', action, chat: inChat ? { key: str(l.peer) } : null, timestamp: num(l.timestamp) || Date.now() });
  }
  return out;
}
