/* The update rows and actions shared by Settings, Help, and the chat list's options. */

import { alertDialog, confirm } from '../../components/Overlays';
import type { ActionRow } from '../../components/RowList';
import { toggleRow } from '../../components/setting-rows';
import { toast } from '../../components/Toast';
import { config } from '../../data/config';
import { applyUpdate, availableUpdate, checkForUpdate, detectInstaller, isChecking, maybeCheckForUpdate, updatePercent, updateStep, type UpdateInfo } from '../../data/updates';
import { friendlyError } from '../../errors';
import { fmt, S } from '../../strings';

const RELOAD_DELAY_MS = 2000;

/** Confirm, then download and install `info`, or save it and show OStore's steps when the phone can't install it for Beacon. */
export async function startUpdate(info: UpdateInfo): Promise<void> {
  if (updateStep() !== 'idle') return;
  const installer = await detectInstaller();
  const title = fmt(S.updateConfirmTitle, { version: info.version });
  const proceed = await confirm({ title, body: installer ? S.updateConfirmBody : S.updateConfirmManualBody, ok: S.skUpdate });
  if (!proceed) return;
  try {
    const outcome = await applyUpdate(info);
    if (outcome.kind === 'manual') {
      await alertDialog(S.updateManualTitle, fmt(S.updateManualBody, { file: outcome.file }));
      return;
    }
    toast(S.updateInstalled, 4000);
    setTimeout(() => location.reload(), RELOAD_DELAY_MS);
  } catch (e) {
    toast(friendlyError(e, S.errUpdateInstall), 5000);
  }
}

export function checkNow(): void {
  checkForUpdate().then(
    (info) => {
      if (!info) toast(S.upToDate);
    },
    (e) => toast(friendlyError(e, S.errUpdateUnavailable))
  );
}

/** The update item for an options menu, while a newer release is waiting. */
export function updateMenuItem(): { label: string; onSelect(): void } | null {
  const info = availableUpdate();
  return info ? { label: fmt(S.updateTo, { version: info.version }), onSelect: () => startUpdate(info) } : null;
}

/** One row showing what the updater is doing, or offering to check or update. */
export function updateRow(): ActionRow {
  const step = updateStep();
  if (step === 'downloading') return { key: 'update', label: fmt(S.updateDownloading, { percent: updatePercent() }), icon: 'download' };
  if (step === 'installing') return { key: 'update', label: S.updateInstalling, icon: 'download' };
  const info = availableUpdate();
  if (info) return { key: 'update', label: fmt(S.updateTo, { version: info.version }), sub: info.security ? S.updateSecurityLabel : undefined, icon: 'download', action: S.skUpdate, onSelect: () => startUpdate(info) };
  if (isChecking()) return { key: 'update', label: S.checkingForUpdates, icon: 'download' };
  return { key: 'update', label: S.checkForUpdates, icon: 'download', onSelect: checkNow };
}

export function autoUpdateRow(refresh: () => void): ActionRow {
  return toggleRow(
    'autoUpdate',
    S.autoUpdateCheck,
    config.autoUpdateCheck(),
    (on) => {
      config.set({ autoUpdateCheck: on });
      refresh();
      if (on) maybeCheckForUpdate();
    },
    S.autoUpdateCheckHint
  );
}
