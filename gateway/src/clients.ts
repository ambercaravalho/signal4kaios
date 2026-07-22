/* Registry of connected app WebSocket clients, keyed by Signal number. Used to
   fan out live frames and to tell whether a number currently has the app open
   (so push can be skipped when the app will notify itself). Each socket may
   report the device's push endpoint (via ?ep= on connect) so push can be
   skipped only for the devices that are actually open, not every device sharing
   the number. */

import type { WebSocket } from 'ws';

// Per number: each connected socket mapped to its push endpoint (or null when
// the device didn't report one, e.g. push unsupported / not yet subscribed).
const byNumber = new Map<string, Map<WebSocket, string | null>>();

export function add(number: string, ws: WebSocket, endpoint?: string | null): void {
  let map = byNumber.get(number);
  if (!map) {
    map = new Map<WebSocket, string | null>();
    byNumber.set(number, map);
  }
  map.set(ws, endpoint || null);
}

export function remove(number: string, ws: WebSocket): void {
  const map = byNumber.get(number);
  if (!map) return;
  map.delete(ws);
  if (map.size === 0) byNumber.delete(number);
}

export function count(number: string): number {
  const map = byNumber.get(number);
  return map ? map.size : 0;
}

/* Push endpoints of the devices currently connected for this number. Push to
   these can be skipped (they self-notify while open); other subscriptions for
   the same number still get a push. */
export function connectedEndpoints(number: string): Set<string> {
  const out = new Set<string>();
  const map = byNumber.get(number);
  if (!map) return out;
  for (const ep of map.values()) {
    if (ep) out.add(ep);
  }
  return out;
}

export function fanout(number: string, obj: unknown): void {
  const map = byNumber.get(number);
  if (!map || map.size === 0) return;
  const msg = JSON.stringify(obj);
  for (const ws of map.keys()) {
    try {
      ws.send(msg);
    } catch {
      /* client is going away; its close handler will clean up */
    }
  }
}
