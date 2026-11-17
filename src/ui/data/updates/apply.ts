/* Downloads, saves, and installs an update, reporting each step through the store's `update` event. */

import { signal } from '../api';
import { config } from '../config';
import { dbg } from '../log';
import { emit } from '../store/events';
import * as ws from '../ws';
import type { UpdateInfo } from './check';
import { downloadUpdate, saveUpdate } from './download';
import { detectInstaller, type Installer, withTimeout } from './install';

export type UpdateStep = 'idle' | 'downloading' | 'installing';

/** `installed`: the install service took the update; `manual`: the phone has none, so the user installs `file` with OStore. */
export type UpdateOutcome = { kind: 'installed' } | { kind: 'manual'; file: string };

const INSTALL_MS = 3 * 60000;

let step: UpdateStep = 'idle';
let percent = 0;

export function updateStep(): UpdateStep {
  return step;
}

/** How much of the download is done, 0 to 100. */
export function updatePercent(): number {
  return percent;
}

function setStep(next: UpdateStep, pct = 0): void {
  step = next;
  percent = pct;
  emit('update');
}

/** Stop the connection first so no message is half-delivered when the install service replaces Beacon. */
function pauseForInstall(): Promise<void> {
  ws.stop();
  if (!config.isConfigured()) return Promise.resolve();
  return signal.flushStorageWrites().catch((e: any) => dbg('update: storage flush failed ' + (e && e.message)));
}

function install(installer: Installer, path: string): Promise<void> {
  setStep('installing');
  return pauseForInstall()
    .then(() => withTimeout(installer.install(path), INSTALL_MS, 'install'))
    .catch((e: any) => {
      dbg('update: ' + installer.name + ' install failed ' + (e && e.message));
      if (config.isConfigured()) ws.connect();
      const err = new Error('install failed');
      err.name = 'UpdateInstall';
      throw err;
    });
}

export function applyUpdate(info: UpdateInfo): Promise<UpdateOutcome> {
  if (step !== 'idle') return Promise.reject(new Error('update already running'));
  setStep('downloading');
  return downloadUpdate(info, (fraction) => {
    const pct = Math.floor(fraction * 100);
    if (pct !== percent) setStep('downloading', pct);
  })
    .then((bytes) => saveUpdate(bytes, info))
    .then((saved) =>
      detectInstaller().then((installer): Promise<UpdateOutcome> | UpdateOutcome => {
        dbg('update: saved ' + saved.name);
        if (!installer) return { kind: 'manual', file: saved.name };
        return install(installer, saved.path).then(() => ({ kind: 'installed' }) as UpdateOutcome);
      })
    )
    .then(
      (outcome) => {
        setStep('idle');
        return outcome;
      },
      (e) => {
        setStep('idle');
        throw e;
      }
    );
}
