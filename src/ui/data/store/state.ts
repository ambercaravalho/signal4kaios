/* All of the store's module state, in one place: other store modules read and write it here instead of keeping their own globals. */

import type { Connection, Contact, Conversation } from '../types';
import type { Listener, StoreEvents } from './events';

export const SELF_NAME = 'Note to Self';

export const listeners: { [K in keyof StoreEvents]?: Array<Listener<K>> } = {};
export const contactsByKey: Record<string, Contact> = {};
export const convs: Record<string, Conversation> = {};
export const typingMap: Record<string, { author: string; until: number }> = {};

export const state = {
  groupsByInternal: {} as Record<string, { id: string; name: string; request?: boolean; addedBy?: string }>,
  openConvId: null as string | null,
  connection: 'closed' as Connection,
  ready: false,
  purgeTimer: null as ReturnType<typeof setInterval> | null,
  notificationClick: null as ((convId: string) => void) | null,
  /** Read-modify-write updates to stored messages run through this one queue so, e.g., a reaction and a receipt arriving together don't clobber each other. */
  mutations: Promise.resolve() as Promise<unknown>,
};
