import { useRef, useState } from 'preact/hooks';
import { useStoreEvent, useTicker } from '../app/hooks';
import { useKeys } from '../app/router';
import { Icon } from '../components/Icon';
import { RichText } from '../components/RichText';
import { Screen } from '../components/Screen';
import { config } from '../data/config';
import { fmtDuration, fmtTimeFull } from '../data/format';
import * as store from '../data/store';
import type { Message, MessageStatus } from '../data/types';
import { plural, S } from '../strings';

const STATUS_LABEL: Record<MessageStatus, string> = { pending: S.sending, failed: S.notSent, sent: S.sent, delivered: S.delivered, read: S.read, received: '' };

function nameOf(key: string): string {
  return key === store.selfNumber() || key === config.aci() ? S.you : store.displayName(key);
}

/** Who chose each option of a poll, as it updates. */
export function PollVotesScreen(props: { msg: Message }) {
  const [m, setM] = useState(props.msg);
  const body = useRef<HTMLDivElement>(null);
  useStoreEvent('message-updated', (rec, oldId) => {
    if (rec.id === m.id || oldId === m.id) setM({ ...rec });
  });
  useKeys((e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && body.current) {
      body.current.scrollTop += e.key === 'ArrowDown' ? 60 : -60;
      return true;
    }
    return false;
  });
  const poll = m.poll;
  if (!poll) return <Screen title={S.viewVotes} />;
  const counts = store.pollCounts(poll);
  const voters = Object.keys(poll.votes);
  return (
    <Screen title={S.viewVotes}>
      <div class="details" ref={body}>
        <div class="details-text">{poll.question}</div>
        {poll.options.map((o, i) => (
          <div class="details-row" key={i}>
            <div class="details-label">
              {o} · {plural(counts[i], S.voteOne, S.voteMany)}
            </div>
            {voters
              .filter((who) => poll.votes[who].options.indexOf(i) >= 0)
              .map((who) => (
                <div class="details-value" key={who}>
                  {nameOf(who)}
                </div>
              ))}
          </div>
        ))}
        {poll.ended && <div class="details-row">{S.pollEnded}</div>}
      </div>
    </Screen>
  );
}

/** The whole message, scrollable, with when it was sent, its status, reactions, and when it disappears. */
export function MessageDetailsScreen(props: { msg: Message }) {
  const [m, setM] = useState(props.msg);
  const body = useRef<HTMLDivElement>(null);
  useTicker(1000, !!m.expiresAt);
  useStoreEvent('message-updated', (rec, oldId) => {
    if (rec.id === m.id || oldId === m.id) setM({ ...rec });
  });

  useKeys((e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && body.current) {
      body.current.scrollTop += e.key === 'ArrowDown' ? 60 : -60;
      return true;
    }
    return false;
  });

  const reactions = Object.keys(m.reactions || {});
  const conv = store.conversation(m.convId);
  const fields: Array<[string, string]> = [];
  if (m.incoming) fields.push([S.from, nameOf(m.author)]);
  else if (conv) fields.push([S.to, conv.name]);
  fields.push([m.incoming ? S.received : S.sent, fmtTimeFull(m.timestamp)]);
  if (!m.incoming && STATUS_LABEL[m.status]) fields.push([S.status, STATUS_LABEL[m.status]]);
  if (m.edited) fields.push([S.edited, S.yes]);
  if (m.expiresAt) fields.push([S.disappearsIn, fmtDuration((m.expiresAt - Date.now()) / 1000)]);
  const privately = !!m.sealed && config.sealedSenderIndicators();

  return (
    <Screen title={S.messageDetails}>
      <div class="details" ref={body}>
        <div class="details-text">{m.deleted ? S.deletedMessage : <RichText text={m.body || store.attachmentLabel(m.attachments)} styles={m.styles} revealSpoilers />}</div>
        {fields.map(([k, v]) => (
          <div class="details-row" key={k}>
            <div class="details-label">{k}</div>
            <div class="details-value">{v}</div>
          </div>
        ))}
        {privately && (
          <div class="details-row">
            <div class="details-label">{S.delivery}</div>
            <div class="details-value">
              <Icon name="lock" /> {S.deliveredPrivately}
            </div>
          </div>
        )}
        {!m.deleted && m.history && m.history.length > 0 && (
          <div class="details-row">
            <div class="details-label">{S.earlierVersions}</div>
            {m.history
              .slice()
              .reverse()
              .map((v) => (
                <div class="details-value" key={v.timestamp}>
                  <div class="details-label">{fmtTimeFull(v.timestamp)}</div>
                  <RichText text={v.body} styles={v.styles} revealSpoilers />
                </div>
              ))}
          </div>
        )}
        {reactions.length > 0 && (
          <div class="details-row">
            <div class="details-label">{S.reactions}</div>
            {reactions.map((who) => (
              <div class="details-value" key={who}>
                <span class="emoji">{m.reactions[who]}</span> {nameOf(who)}
              </div>
            ))}
          </div>
        )}
      </div>
    </Screen>
  );
}
