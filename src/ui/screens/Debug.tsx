/* Settings > Debug: the one place technical terms are shown, for troubleshooting and bug reports. */

import { useEffect, useRef, useState } from 'preact/hooks';
import { useStoreEvents } from '../app/hooks';
import { router, useKeys, useSoftkeys } from '../app/router';
import { Row, RowList } from '../components/RowList';
import { Screen } from '../components/Screen';
import { toast } from '../components/Toast';
import { net } from '../../engine/net/transport';
import { signal } from '../data/api';
import { db } from '../data/db';
import { fmtBytes, fmtTimeFull } from '../data/format';
import { logLines, redactedLog } from '../data/log';
import { NativeTlsState, nativeTlsState, onNativeTlsChange, probe } from '../data/nativeTls';
import { appVersion, openActivity, openUrl } from '../data/platform';
import { connectionState } from '../data/store';
import * as ws from '../data/ws';
import { friendlyError } from '../errors';
import { DEBUG, S } from '../strings';
import { SETUP_URL } from './Onboarding';

type Diagnostics = Awaited<ReturnType<typeof signal.diagnostics>>;

export const CERT_GUIDE_URL = SETUP_URL + '#optional-for-rooted-phones-trust-signals-certificate';

function useNativeTls(): NativeTlsState {
  const [state, setState] = useState(nativeTlsState());
  useEffect(() => onNativeTlsChange(setState), []);
  return state;
}

function fasterLabel(state: NativeTlsState): string {
  return state === 'trusted' ? DEBUG.fasterOn : state === 'untrusted' ? DEBUG.fasterOff : DEBUG.fasterChecking;
}

function storageEstimate(): Promise<{ usage?: number; quota?: number } | null> {
  const s = (navigator as Navigator & { storage?: { estimate?(): Promise<{ usage?: number; quota?: number }> } }).storage;
  return s && s.estimate ? s.estimate().catch(() => null) : Promise.resolve(null);
}

function shareLog(): void {
  const blob = new Blob([redactedLog()], { type: 'text/plain' });
  openActivity('share', { type: 'text/plain', number: 1, blobs: [blob], filenames: ['beacon-debug.txt'] }).catch((e) => toast(friendlyError(e)));
}

export function DebugScreen() {
  useStoreEvents(['connection']);
  const tlsState = useNativeTls();
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [lib, setLib] = useState('');
  const [version, setVersion] = useState('');
  const [storage, setStorage] = useState('');
  const [busy, setBusy] = useState(false);

  const loadDiag = () => signal.diagnostics().then(setDiag, () => {});
  useEffect(() => {
    loadDiag();
    signal.ready().then(setLib, () => {});
    appVersion().then(setVersion);
    storageEstimate().then((e) => e && e.usage != null && setStorage(fmtBytes(e.usage) + (e.quota ? ' / ' + fmtBytes(e.quota) : '')));
  }, []);

  async function action(p: () => Promise<unknown>, done: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await p();
      toast(done);
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  const info = (key: string, label: string, value: string | number | undefined): Row => ({ key, label, sub: value === undefined || value === '' ? '…' : String(value) });
  const last = ws.lastMessageAt();
  const rows: Row[] = [
    info('ver', DEBUG.appVersion, version),
    info('lib', DEBUG.libsignalVersion, lib),
    info('aci', DEBUG.accountId, diag ? diag.aci : undefined),
    info('pni', DEBUG.phoneNumberId, diag ? diag.pni : undefined),
    info('dev', DEBUG.deviceId, diag ? diag.deviceId : undefined),
    info('reg', DEBUG.registrationId, diag ? diag.registrationId : undefined),
    info('pk', DEBUG.preKeys, diag ? (diag.preKeys ? diag.preKeys.ec : DEBUG.preKeysUnknown) : undefined),
    info('kpk', DEBUG.kyberPreKeys, diag ? (diag.preKeys ? diag.preKeys.kyber : DEBUG.preKeysUnknown) : undefined),
    info('ws', DEBUG.connection, connectionState()),
    info('tls', DEBUG.tls, net.pinnedTlsAvailable() ? DEBUG.available : DEBUG.unavailable),
    { key: 'faster', label: DEBUG.fasterConnection, sub: fasterLabel(tlsState), end: 'chevron', onSelect: () => router.push(FasterConnectionScreen, {}) },
    info('last', DEBUG.lastMessage, last ? fmtTimeFull(last) : DEBUG.never),
    info('db', DEBUG.database, db.name()),
    info('store', DEBUG.storage, storage || DEBUG.unavailable),
    { section: '' },
    { key: 'refresh', label: DEBUG.refreshPreKeys, onSelect: () => action(() => signal.replenishPreKeys().then(loadDiag), DEBUG.preKeysRefreshed) },
    { key: 'sync', label: DEBUG.requestSync, onSelect: () => action(() => signal.requestSync(), DEBUG.syncRequested) },
    { key: 'reconnect', label: DEBUG.reconnect, onSelect: () => (ws.restart(), toast(DEBUG.reconnecting)) },
    { key: 'log', label: DEBUG.viewLog, end: 'chevron', onSelect: () => router.push(DebugLogScreen, {}) },
    { key: 'share', label: DEBUG.shareLog, onSelect: shareLog },
  ];
  return (
    <Screen title={DEBUG.title}>
      <RowList rows={rows} compact />
    </Screen>
  );
}

/** Whether attachment transfers use the platform's TLS, which needs Signal's root certificate on a rooted phone. */
export function FasterConnectionScreen() {
  const state = useNativeTls();
  const [checking, setChecking] = useState(false);
  async function checkAgain(): Promise<void> {
    if (checking) return;
    setChecking(true);
    const ok = await probe();
    setChecking(false);
    toast(ok ? DEBUG.fasterNowOn : DEBUG.fasterStillOff);
  }
  const rows: Row[] = [
    { key: 'state', label: DEBUG.fasterStatus, sub: checking ? DEBUG.fasterChecking : fasterLabel(state) },
    { key: 'scope', label: DEBUG.fasterUsedFor, sub: DEBUG.fasterUsedForValue },
    { key: 'needs', label: DEBUG.fasterNeeds, sub: DEBUG.fasterNeedsValue },
    { key: 'other', label: DEBUG.fasterOther, sub: DEBUG.fasterOtherValue },
    { section: '' },
    { key: 'how', label: DEBUG.fasterHowTo, end: 'chevron', onSelect: () => openUrl(CERT_GUIDE_URL).catch(() => toast(S.errGeneric)) },
    { key: 'check', label: DEBUG.fasterCheckAgain, onSelect: checkAgain },
  ];
  return (
    <Screen title={DEBUG.fasterConnection}>
      <RowList rows={rows} compact />
    </Screen>
  );
}

/** The in-memory log, newest last. Shown unredacted because it never leaves the phone from here. */
export function DebugLogScreen() {
  const body = useRef<HTMLDivElement>(null);
  const lines = logLines();
  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, []);
  useSoftkeys({ center: null, right: DEBUG.share });
  useKeys((e) => {
    if (e.key === 'SoftRight') shareLog();
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && body.current) body.current.scrollTop += e.key === 'ArrowDown' ? 60 : -60;
    else return false;
    return true;
  });
  return (
    <Screen title={DEBUG.viewLog}>
      <div class="debug-log" ref={body}>
        {lines.length ? lines.map((l, i) => <div key={i}>{l}</div>) : DEBUG.logEmpty}
      </div>
    </Screen>
  );
}
