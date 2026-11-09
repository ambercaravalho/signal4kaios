/* Connects the engine to the app's HTTP client, database, config, log, and store. */

import { setEngineHost } from '../../engine/host';
import { config } from './config';
import { db } from './db';
import { http } from './http';
import { dbg } from './log';
import { applyChatState, ingestRaw, refreshDirectory } from './store';

export function installEngineHost(): void {
  setEngineHost({
    http,
    db,
    config: {
      serverUrl: () => config.serverUrl(),
      aci: () => config.aci(),
      profileName: () => config.profileName(),
      sharePhoneNumber: () => config.sharePhoneNumber(),
      set: (patch) => config.set(patch),
    },
    dbg: (msg) => dbg(msg),
    directoryChanged: () => refreshDirectory(),
    applyChatState,
    ingest: (frame) => ingestRaw(frame),
  });
}
