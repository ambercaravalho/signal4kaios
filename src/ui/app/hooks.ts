import { useEffect, useRef, useState } from 'preact/hooks';
import { on, StoreEvents } from '../data/store';

/** Re-render when any of these store events fire (and `filter` accepts them). */
export function useStoreEvents<K extends keyof StoreEvents>(events: K[], filter?: (evt: K, ...args: any[]) => boolean): number {
  const [v, setV] = useState(0);
  const f = useRef(filter);
  f.current = filter;
  useEffect(() => {
    const offs = events.map((evt) =>
      on(evt, ((...args: any[]) => {
        if (!f.current || f.current(evt, ...args)) setV((n) => n + 1);
      }) as any)
    );
    return () => offs.forEach((off) => off());
  }, [events.join(',')]);
  return v;
}

/** Subscribe to one store event for the component's lifetime. */
export function useStoreEvent<K extends keyof StoreEvents>(evt: K, fn: (...args: StoreEvents[K]) => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => on(evt, ((...args: StoreEvents[K]) => ref.current(...args)) as any), [evt]);
}

/** Re-render every `ms` while mounted, for countdowns and relative times. */
export function useTicker(ms: number, active = true): void {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms, active]);
}
