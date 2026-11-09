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
import { appVersion, openActivity } from '../data/platform';
import { connectionState } from '../data/store';
import * as ws from '../data/ws';
import { friendlyError } from '../errors';
import { DEBUG } from '../strings';

type Diagnostics = Awaited<ReturnType<typeof signal.diagnostics>>;

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
