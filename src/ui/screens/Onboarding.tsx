import { useEffect, useRef, useState } from 'preact/hooks';
import { router, useKeys, useSoftkeys } from '../app/router';
import { Spinner } from '../components/List';
import { DIVIDER, prompt, showOptions } from '../components/Overlays';
import { Pictogram } from '../components/Pictogram';
import { QrCode } from '../components/Qr';
import { Screen } from '../components/Screen';
import { toast } from '../components/Toast';
import type { ProvisioningSession } from '../../engine/net/provisioning';
import { signal } from '../data/api';
import { config } from '../data/config';
import { db } from '../data/db';
import { dbg } from '../data/log';
import * as ws from '../data/ws';
import { APP_NAME, S } from '../strings';
import { openGuide } from './Guide';

/** First run: what Beacon is, then on to linking. */
export function WelcomeScreen() {
  useSoftkeys({ left: null, center: S.getStarted, right: S.help });
  useKeys((e) => {
    if (e.key === 'Enter') router.replace(LinkScreen, { mode: 'first' as const });
    else if (e.key === 'SoftRight') openGuide('setup');
    else return false;
    return true;
  });
  return (
    <Screen title={APP_NAME} bodyClass="welcome">
      <Pictogram name="welcome" />
      <div class="welcome-title">{S.welcomeTitle}</div>
      <p>{S.welcomeBody}</p>
      <p class="welcome-note">{S.unofficial}</p>
    </Screen>
  );
}

type LinkState = 'connecting' | 'waiting' | 'finishing' | 'syncing' | 'failed';

/** Shows the code to scan from Signal on the main phone. `first` is the first run, `add` adds another account, `relink` follows an unlink. */
export function LinkScreen(props: { mode: 'first' | 'add' | 'relink' }) {
  const [uri, setUri] = useState('');
  const [state, setState] = useState<LinkState>('connecting');
  const [attempt, setAttempt] = useState(0);
  const session = useRef<ProvisioningSession | null>(null);
  const root = props.mode !== 'add';

  useEffect(() => {
    let switched = false;
    let live = true;
    setUri('');
    setState('connecting');
    const deviceName = config.deviceName() || S.defaultDeviceName;
    session.current = signal.startProvisioning(deviceName, {
      onQrUrl: (u) => {
        if (!live) return;
        setUri(u);
        setState('waiting');
      },
      onStatus: (msg) => {
        dbg('link: ' + msg);
        if (live) setState('finishing');
      },
      beforeLinking: (account) => {
        ws.stop();
        switched = true;
        return db.useAccount(account.number || account.aci);
      },
      onLinked: (creds) => {
        session.current = null;
        // SECURITY-REVIEW: the device password goes to config storage only; it is never logged or shown.
        config.set({ number: creds.number || creds.aci, dbNumber: creds.number || creds.aci, aci: creds.aci, deviceId: creds.deviceId, deviceToken: creds.password, deviceName });
        config.saveActiveAccount();
        setState('syncing');
        signal
          .requestSync()
          .catch(() => {})
          .then(() => location.reload());
      },
      onError: (err) => {
        session.current = null;
        dbg('link failed: ' + (err && err.message));
        if (live) setState('failed');
        if (switched) {
          switched = false;
          db.useAccount(null).then(() => {
            if (config.isConfigured()) ws.connect();
          });
        }
      },
    });
    return () => {
      live = false;
      if (session.current) session.current.cancel();
      session.current = null;
    };
  }, [attempt]);

  async function rename(): Promise<void> {
    const v = await prompt({ title: S.deviceName, value: config.deviceName() || S.defaultDeviceName, maxLength: 40 });
    if (!v) return;
    config.set({ deviceName: v });
    setAttempt((n) => n + 1);
    toast(S.saved);
  }

  const busy = state === 'finishing' || state === 'syncing';
  useSoftkeys({ left: root ? null : undefined, center: state === 'failed' ? S.retry : null, right: busy ? null : S.options });
  useKeys((e) => {
    if (e.key === 'Enter' && state === 'failed') setAttempt((n) => n + 1);
    else if (e.key === 'SoftRight' && !busy)
      showOptions([
        { label: S.newCode, onSelect: () => setAttempt((n) => n + 1) },
        { label: S.deviceName, onSelect: rename },
        DIVIDER,
        { label: S.howToLink, onSelect: () => openGuide('linking') },
      ]);
    else if (busy && (e.key === 'Backspace' || e.key === 'SoftLeft')) return true;
    else return false;
    return true;
  });

  let content;
  if (state === 'failed') content = <div class="link-status link-failed">{S.linkFailed}</div>;
  else if (busy) content = <Spinner label={state === 'syncing' ? S.linkSyncing : S.linkFinishing} />;
  else if (!uri) content = <Spinner label={S.connecting} />;
  else content = <QrCode text={uri} />;

  return (
    <Screen title={props.mode === 'add' ? S.addAccount : S.linkTitle} bodyClass="link-screen">
      {props.mode === 'relink' && <div class="link-note">{S.unlinked}</div>}
      {content}
      {!busy && state !== 'failed' && <p class="link-steps">{S.linkSteps}</p>}
    </Screen>
  );
}
