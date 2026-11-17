import { useStoreEvents } from '../app/hooks';
import { availableUpdate } from '../data/updates';
import { fmt, S } from '../strings';
import { Banner } from './Toast';

/** A newer Beacon under the chat list's header; the update itself is in Options. */
export function UpdateBanner() {
  useStoreEvents(['update']);
  const info = availableUpdate();
  if (!info) return null;
  return <Banner tone={info.security ? 'warn' : 'info'}>{fmt(info.security ? S.updateBannerSecurity : S.updateBanner, { version: info.version })}</Banner>;
}
