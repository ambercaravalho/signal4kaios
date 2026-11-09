/* Reporting a message request as spam, ported from Signal-Desktop's reportSpamJobQueue and WebAPI reportMessage. */

import type { SignalHttpJsonFn } from '../net/http';
import { DEFAULT_SIGNAL_SERVER } from '../net/http';
import { isAci } from '../net/proto';
import type { SignalProtocolStore } from '../protocol/store';

/** Signal-Desktop's ReportSpamJobData caps one report at 1000 messages. */
export const REPORT_SPAM_MAX_GUIDS = 1000;

/** Reports each message (by its server GUID) from `aci`; `token` is the base64 reporting token the server last sent with their messages. */
export async function reportSpam(
  store: SignalProtocolStore,
  httpJson: SignalHttpJsonFn,
  aci: string,
  serverGuids: string[],
  token?: string,
  serverUrl = DEFAULT_SIGNAL_SERVER
): Promise<number> {
  if (!isAci(aci)) throw new Error('Only a Signal account can be reported');
  const guids = serverGuids.filter(isAci).slice(0, REPORT_SPAM_MAX_GUIDS);
  if (!guids.length) return 0;
  const acc = await store.getAccount();
  if (!acc) throw new Error('Not linked');
  // SECURITY-REVIEW: device credentials authenticate the report calls; never log them or the reporting token.
  const opts = { baseUrl: serverUrl, basicAuth: { username: `${acc.aci}.${acc.deviceId}`, password: acc.password }, timeout: 15000 };
  await Promise.all(guids.map((guid) => httpJson('POST', `/v1/messages/report/${aci}/${guid}`, token ? { token } : {}, opts)));
  return guids.length;
}
