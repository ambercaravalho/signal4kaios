/* Settings > Privacy > Proxy, and the question asked when someone opens a Signal proxy link. */

import { useState } from 'preact/hooks';
import { confirm, prompt } from '../components/Overlays';
import { Row, RowList } from '../components/RowList';
import { Screen } from '../components/Screen';
import { toast } from '../components/Toast';
import { config } from '../data/config';
import { isProxyLink, parseProxyLink, saveProxy } from '../data/proxy';
import * as ws from '../data/ws';
import { fmt, S } from '../strings';

export { isProxyLink };

function changeProxy(address: string, enabled: boolean): void {
  saveProxy(address, enabled);
  ws.restart();
  toast(enabled ? S.proxyOn : S.proxyOff);
}

async function askAddress(current: string): Promise<string | null> {
  const v = await prompt({ title: S.proxyAddress, value: current, hint: S.proxyAddressHint, maxLength: 300 });
  if (v === undefined) return null;
  const host = parseProxyLink(v);
  if (!host) toast(S.proxyInvalid);
  return host;
}

/** A `signal.tube` link was opened: offer to use that proxy. */
export async function askUseProxy(link: string): Promise<void> {
  const host = parseProxyLink(link);
  if (!host) {
    toast(S.proxyInvalid);
    return;
  }
  if (config.proxyEnabled() && config.proxyAddress() === host) {
    toast(S.proxyOn);
    return;
  }
  if (await confirm({ title: S.useThisProxy, body: fmt(S.useProxyBody, { host }), ok: S.useProxy })) changeProxy(host, true);
}

export function ProxyScreen() {
  const [, setN] = useState(0);
  const refresh = () => setN((n) => n + 1);
  const address = config.proxyAddress();
  const enabled = config.proxyEnabled() && !!address;

  async function toggle(): Promise<void> {
    if (enabled) {
      changeProxy(address, false);
    } else {
      const host = address || (await askAddress(''));
      if (!host) return;
      changeProxy(host, true);
    }
    refresh();
  }

  async function editAddress(): Promise<void> {
    const host = await askAddress(address);
    if (!host || host === address) return;
    changeProxy(host, enabled || !address);
    refresh();
  }

  const rows: Row[] = [
    { key: 'use', label: S.useProxy, sub: S.useProxyHint, end: 'toggle', checked: enabled, action: enabled ? S.turnOff : S.turnOn, onSelect: toggle },
    { key: 'addr', label: S.proxyAddress, sub: address || S.usernameNone, onSelect: editAddress },
  ];
  return (
    <Screen title={S.proxy}>
      <RowList rows={rows} />
    </Screen>
  );
}
