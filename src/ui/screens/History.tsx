import { useEffect, useState } from 'preact/hooks';
import { useKeys, useSoftkeys } from '../app/router';
import { Spinner } from '../components/List';
import { Screen } from '../components/Screen';
import { config } from '../data/config';
import { db } from '../data/db';
import { dbg } from '../data/log';
import { endHistorySync, type HistoryPhase, runHistorySync } from '../data/store/history';
import { fmt, S } from '../strings';

type HistoryState = 'running' | 'failed' | 'relink';

function phaseLabel(p: HistoryPhase | null): string {
  if (!p || p.step === 'waiting') return S.historyWaiting;
  const n = Math.floor(p.fraction * 100);
  return fmt(p.step === 'downloading' ? S.historyDownloading : S.historyAdding, { n });
}

/** Once the history is in, or skipped, the app starts as usual. */
function leave(): void {
  endHistorySync().then(() => location.reload());
}

/** After linking, while the main phone sends message history (link-and-sync): waiting, downloading, then adding. The app stays offline until this ends, so nothing new arrives in the middle; Skip goes on without history. */
export function HistoryScreen() {
  const [phase, setPhase] = useState<HistoryPhase | null>(null);
  const [state, setState] = useState<HistoryState>('running');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState('running');
    runHistorySync(
      (p) => !cancelled && setPhase(p),
      () => cancelled
    ).then(
      (outcome) => {
        if (cancelled) return;
        if (outcome === 'relink') setState('relink');
        else leave();
      },
      (e) => {
        if (cancelled) return;
        dbg('history: ' + ((e && e.name) || 'error') + ' ' + ((e && e.message) || ''));
        setState('failed');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  function relink(): void {
    endHistorySync()
      .then(() => db.clearSignalState())
      .then(() => {
        config.forgetAccount();
        location.reload();
      });
  }

  useSoftkeys({ left: null, center: state === 'failed' ? S.retry : state === 'relink' ? S.linkAgain : null, right: state === 'relink' ? null : S.skip });
  useKeys((e) => {
    if (e.key === 'Enter' && state === 'failed') setAttempt((n) => n + 1);
    else if (e.key === 'Enter' && state === 'relink') relink();
    else if (e.key === 'SoftRight' && state !== 'relink') leave();
    else if (e.key === 'Backspace' || e.key === 'SoftLeft') return true;
    else return false;
    return true;
  });

  return (
    <Screen title={S.historyTitle} bodyClass="link-screen">
      {state === 'failed' && <div class="link-status link-failed">{S.historyFailed}</div>}
      {state === 'relink' && <div class="link-status">{S.historyRelink}</div>}
      {state === 'running' && <Spinner label={phaseLabel(phase)} />}
      {state === 'running' && <p class="link-steps">{!phase || phase.step === 'waiting' ? S.historyWaitingHint : S.historyKeepOpen}</p>}
    </Screen>
  );
}
