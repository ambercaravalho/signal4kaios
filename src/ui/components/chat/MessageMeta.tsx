import { fmtClock } from '../../data/format';
import type { Message } from '../../data/types';
import { S } from '../../strings';
import { Icon } from '../Icon';
import { StatusIcon } from './StatusIcon';

export function MessageMeta(props: { m: Message }) {
  const { m } = props;
  return (
    <span class="msg-meta">
      {m.pinned && <Icon name="pin" />}
      {m.edited && !m.deleted && <span>{S.edited}</span>}
      {m.expiresAt ? <Icon name="timer" /> : null}
      <span>{fmtClock(m.timestamp)}</span>
      {!m.incoming && <StatusIcon status={m.status} />}
    </span>
  );
}
