import { router } from '../../app/router';
import { confirm } from '../../components/Overlays';
import { Row, RowList } from '../../components/RowList';
import { Screen } from '../../components/Screen';
import { toast } from '../../components/Toast';
import { signal, unlink } from '../../data/api';
import { config } from '../../data/config';
import { db } from '../../data/db';
import * as ws from '../../data/ws';
import { friendlyError } from '../../errors';
import { S } from '../../strings';
import { LinkScreen } from '../Onboarding';

/** Every account's database and all settings, then a fresh start at the welcome screen. */
export async function deleteAllData(): Promise<void> {
  ws.stop();
  for (const a of config.accounts()) await db.useAccount(a.dbNumber || a.number).then(() => db.wipe()).catch(() => {});
  await db.useAccount(null).then(() => db.wipe()).catch(() => {});
  config.clear();
  location.reload();
}

export function LinkedDeviceScreen() {
  const active = config.number();
  const accounts = config.accounts();

  async function doUnlink(): Promise<void> {
    if (!(await confirm({ title: S.unlinkPhone + '?', body: S.unlinkConfirm, ok: S.unlink, danger: true }))) return;
    ws.stop();
    await unlink();
    config.forgetAccount();
    location.reload();
  }

  async function deleteAll(): Promise<void> {
    if (!(await confirm({ title: S.deleteAllData + '?', body: S.deleteAllDataBody, ok: S.delete, danger: true }))) return;
    await deleteAllData();
  }

  function sync(): void {
    signal.requestSync().then(
      () => toast(S.syncRequested),
      (e) => toast(friendlyError(e))
    );
  }

  const rows: Row[] = [
    { key: 'as', label: S.linkedAs, sub: [config.number(), config.deviceName()].filter(Boolean).join(' · ') },
    { key: 'sync', label: S.syncNow, onSelect: sync },
    { section: S.accounts },
    ...accounts.map((a) => ({
      key: 'acc:' + a.number,
      label: a.number,
      end: 'radio' as const,
      checked: a.number === active,
      action: S.switchAccount,
      onSelect:
        a.number === active
          ? undefined
          : () => {
              ws.stop();
              config.switchAccount(a.number);
              location.reload();
            },
    })),
    { key: 'add', label: S.addAccount, onSelect: () => router.push(LinkScreen, { mode: 'add' as const }) },
    { section: '' },
    { key: 'unlink', label: S.unlinkPhone, danger: true, onSelect: doUnlink },
    { key: 'wipe', label: S.deleteAllData, danger: true, onSelect: deleteAll },
  ];
  return (
    <Screen title={S.linkedDevice}>
      <RowList rows={rows} />
    </Screen>
  );
}
