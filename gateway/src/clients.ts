/* Registry of connected app WebSocket clients, keyed by Signal number. Used to
   fan out live frames and to tell whether a number currently has the app open
   (so push can be skipped when the app will notify itself). */

import type { WebSocket } from 'ws';

const byNumber = new Map<string, Set<WebSocket>>();

export function add(number: string, ws: WebSocket): void {
  let set = byNumber.get(number);
  if (!set) {
    set = new Set<WebSocket>();
    byNumber.set(number, set);
  }
  set.add(ws);
}

export function remove(number: string, ws: WebSocket): void {
  const set = byNumber.get(number);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) byNumber.delete(number);
}

export function count(number: string): number {
  const set = byNumber.get(number);
  return set ? set.size : 0;
}

export function fanout(number: string, obj: unknown): void {
  const set = byNumber.get(number);
  if (!set || set.size === 0) return;
  const msg = JSON.stringify(obj);
  for (const ws of set) {
    try {
      ws.send(msg);
    } catch {
      /* client is going away; its close handler will clean up */
    }
  }
}
