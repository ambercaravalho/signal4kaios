import { useKeys, useSoftkeys } from '../app/router';
import { alertDialog } from '../components/Overlays';
import { Pictogram } from '../components/Pictogram';
import { Screen } from '../components/Screen';
import { S } from '../strings';
import { openGuide } from './Guide';

function bodyFor(reason: string): string {
  if (reason === 'blocked') return S.cantStartBlocked;
  if (reason === 'no-webassembly') return S.cantStartUnsupported;
  if (reason === 'fetch') return S.cantStartDamaged;
  if (reason === 'storage') return S.storageError;
  return S.cantStartBody;
}

/** Shown instead of the app when it can't start. The technical detail is one key away for bug reports. */
export function StartupErrorScreen(props: { reason: string; detail: string }) {
  useSoftkeys({ left: props.detail ? S.showDetails : null, center: S.restart, right: S.help });
  useKeys((e) => {
    if (e.key === 'Enter') location.reload();
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
