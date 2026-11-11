import * as store from '../../data/store';
import type { Poll } from '../../data/types';
import { S } from '../../strings';

export function PollView(props: { poll: Poll }) {
  const { poll } = props;
  const counts = store.pollCounts(poll);
  const mine = poll.votes[store.selfNumber()];
  return (
    <div class="poll">
      <div class="poll-question">{poll.question}</div>
      {poll.options.map((o, i) => (
        <div class="poll-option" key={i}>
          <span class={'poll-mark' + (poll.allowMultiple ? ' poll-mark-many' : '') + (mine && mine.options.indexOf(i) >= 0 ? ' on' : '')} />
          <span class="poll-option-text">{o}</span>
          <span class="poll-count">{counts[i]}</span>
        </div>
      ))}
      <div class="poll-sub">{poll.ended ? S.pollEnded : poll.allowMultiple ? S.pollChooseMany : S.pollChooseOne}</div>
    </div>
  );
}
