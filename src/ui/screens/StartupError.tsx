import { useKeys, useSoftkeys } from '../app/router';
import { alertDialog, confirm, DIVIDER, type MenuEntry, showOptions } from '../components/Overlays';
import { Pictogram } from '../components/Pictogram';
import { Screen } from '../components/Screen';
import { S } from '../strings';
import { openGuide } from './Guide';
import { deleteAllData } from './settings/LinkedDevice';

function bodyFor(reason: string): string {
  if (reason === 'blocked') return S.cantStartBlocked;
  if (reason === 'no-webassembly') return S.cantStartUnsupported;
  if (reason === 'fetch') return S.cantStartDamaged;
  if (reason === 'storage') return S.storageError;
  return S.cantStartBody;
}

/** The right softkey's menu when the database can't be opened. */
export function storageErrorOptions(): MenuEntry[] {
  return [
    { label: S.help, onSelect: () => openGuide('troubleshooting') },
    DIVIDER,
    {
      label: S.deleteAllData,
      danger: true,
      onSelect: async () => {
        if (await confirm({ title: S.deleteAllData + '?', body: S.deleteAllDataBody, ok: S.delete, danger: true })) await deleteAllData();
      },
    },
  ];
}

/** Shown instead of the app when it can't start. The technical detail is one key away for bug reports. */
export function StartupErrorScreen(props: { reason: string; detail: string }) {
  const storage = props.reason === 'storage';
  useSoftkeys({ left: props.detail ? S.showDetails : null, center: S.restart, right: storage ? S.options : S.help });
  useKeys((e) => {
    if (e.key === 'Enter') location.reload();
    else if (e.key === 'SoftRight' && storage) showOptions(storageErrorOptions());
    else if (e.key === 'SoftRight') openGuide('troubleshooting');
    else if (e.key === 'SoftLeft' && props.detail) alertDialog(S.showDetails, props.detail);
    else return false;
    return true;
  });
  return (
    <Screen title={S.cantStart} bodyClass="welcome">
      <Pictogram name="trouble" />
      <p>{bodyFor(props.reason)}</p>
    </Screen>
  );
}
