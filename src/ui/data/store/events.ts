/* The store's event hub: screens subscribe with `on`, store modules call `emit`. */

import type { ExpiredRef } from '../db';
import { dbg } from '../log';
import type { Connection, Message } from '../types';
import { listeners } from './state';

export interface StoreEvents {
  conversations: [];
  message: [Message];
  'message-updated': [Message, string | undefined];
  'message-removed': [ExpiredRef];
  typing: [string];
  connection: [Connection];
  'storage-error': [string];
}

export type Listener<K extends keyof StoreEvents> = (...args: StoreEvents[K]) => void;

export function on<K extends keyof StoreEvents>(evt: K, fn: Listener<K>): () => void {
  const arr = (listeners[evt] = listeners[evt] || []) as Array<Listener<K>>;
  arr.push(fn);
  return () => {
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  };
}

export function emit<K extends keyof StoreEvents>(evt: K, ...args: StoreEvents[K]): void {
  for (const fn of ((listeners[evt] || []) as Array<Listener<K>>).slice()) {
    try {
      fn(...args);
    } catch (e: any) {
      dbg('listener error [' + evt + '] ' + (e && e.message));
    }
  }
}
