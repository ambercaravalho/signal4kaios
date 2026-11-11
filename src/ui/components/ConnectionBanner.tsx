import { net } from '../../engine/net/transport';
import { useStoreEvents } from '../app/hooks';
import { connectionState } from '../data/store';
import { S } from '../strings';
import { Banner } from './Toast';

/** Connection state under the header, shown only while not connected. */
export function ConnectionBanner() {
  useStoreEvents(['connection']);
  const state = connectionState();
  if (state === 'open') return null;
  const proxied = !!net.proxy();
  const closed = proxied ? S.offlineProxy : S.offline;
  const connecting = proxied ? S.connectingProxy : S.connecting;
  return <Banner tone={state === 'closed' ? 'warn' : 'info'}>{state === 'closed' ? closed : connecting}</Banner>;
}
