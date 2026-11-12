/* Connects the engine to the app's HTTP client, database, config, log, and store. */

import { setEngineHost } from '../../engine/host';
import { config } from './config';
import { db } from './db';
import { http } from './http';
import { dbg } from './log';
import { ownPhotoChanged } from './own-photo';
import { applyChatState, ingestRaw, refreshDirectory } from './store';

const numberListeners = new Set<(number: string) => void>();

export function onNumberChange(fn: (number: string) => void): () => void {
  numberListeners.add(fn);
  return () => {
    numberListeners.delete(fn);
  };
}

export function installEngineHost(): void {
  setEngineHost({
    http,
    db,
    config: {
      serverUrl: () => config.serverUrl(),
      aci: () => config.aci(),
      profileName: () => config.profileName(),
      sharePhoneNumber: () => config.sharePhoneNumber(),
      stickerPacks: () => config.stickerPacks(),
      set: (patch) => config.set(patch),
    },
    dbg: (msg) => dbg(msg),
    directoryChanged: () => {
      ownPhotoChanged();
      return refreshDirectory();
    },
    applyChatState,
    ingest: (frame) => ingestRaw(frame),
    numberChanged: (number) => {
      config.changeNumber(number);
      numberListeners.forEach((f) => f(number));
    },
  });
}
