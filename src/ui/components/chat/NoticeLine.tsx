import { useFocusScroll } from '../../app/focus';
import { fmtClock } from '../../data/format';
import * as store from '../../data/store';
import type { Message, Notice } from '../../data/types';
import { Icon } from '../Icon';

function noticeIcon(n: Notice): string {
  if (n.kind === 'safetyNumber') return 'verified';
  if (n.kind === 'pollEnded') return 'poll';
  if (n.kind === 'timer' || (n.kind === 'groupUpdate' && n.change === 'timer')) return 'timer';
  if (n.kind === 'groupUpdate') return 'group';
  return 'phone';
}

export function NoticeLine(props: { m: Message; focused: boolean }) {
  const { m } = props;
  const ref = useFocusScroll<HTMLDivElement>(props.focused);
  return (
    <div class={'notice' + (props.focused ? ' focused' : '')} ref={ref} role="listitem">
      <Icon name={noticeIcon(m.notice!)} />
      <span class="notice-text">{store.noticeText(m.notice!, m.author)}</span>
      <span class="notice-time">{fmtClock(m.timestamp)}</span>
    </div>
  );
}
