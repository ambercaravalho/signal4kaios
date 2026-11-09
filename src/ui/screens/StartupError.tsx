import { useKeys, useSoftkeys } from '../app/router';
import { alertDialog } from '../components/Overlays';
import { Screen } from '../components/Screen';
import { openUrl } from '../data/platform';
import { S } from '../strings';
import { SETUP_URL } from './Onboarding';

const WASM_GUIDE_URL = SETUP_URL + '#kaios-40-enable-webassembly';

function bodyFor(reason: string): string {
  if (reason === 'blocked') return S.cantStartBlocked;
  if (reason === 'no-webassembly') return S.cantStartUnsupported;
  if (reason === 'fetch') return S.cantStartDamaged;
  if (reason === 'storage') return S.storageError;
  return S.cantStartBody;
}

/** Shown instead of the app when it can't start. The technical detail is one key away for bug reports. */
export function StartupErrorScreen(props: { reason: string; detail: string }) {
  useSoftkeys({ left: props.detail ? S.showDetails : null, center: S.restart, right: S.setupGuide });
  useKeys((e) => {
    if (e.key === 'Enter') location.reload();
    else if (e.key === 'SoftRight') openUrl(props.reason === 'blocked' ? WASM_GUIDE_URL : SETUP_URL).catch(() => {});
    else if (e.key === 'SoftLeft' && props.detail) alertDialog(S.showDetails, props.detail);
    else return false;
    return true;
  });
  return (
    <Screen title={S.cantStart} bodyClass="welcome">
      <p>{bodyFor(props.reason)}</p>
    </Screen>
  );
}
