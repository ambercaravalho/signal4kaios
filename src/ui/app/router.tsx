/* One stack of screens and overlays. Every entry stays mounted so scroll position and focus survive going back; only the top screen (and overlays above it) are shown, and only the top entry gets keys and softkeys.

   KaiOS keys: the Back key arrives as Backspace and closes the app unless prevented. Back deletes inside a non-empty text field and otherwise goes up a level; SoftLeft also goes back on pushed screens unless the screen claims it. */

import { Component, ComponentType, createContext } from 'preact';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { S } from '../strings';

export type KeyHandler = (e: KeyboardEvent) => boolean | void;

export interface SoftkeyLabels {
  left?: string | null;
  center?: string | null;
  right?: string | null;
}

interface Entry {
  id: number;
  overlay: boolean;
  Component: ComponentType<any>;
  props: any;
  handlers: Array<{ current: KeyHandler }>;
  softkeys: SoftkeyLabels;
  onResume: Array<() => void>;
}

const EXIT_COOLDOWN_MS = 600;

let stack: Entry[] = [];
let nextId = 1;
let lastPopAt = 0;
const subscribers = new Set<() => void>();

function changed(): void {
  for (const fn of Array.from(subscribers)) fn();
}

function topEntry(): Entry | undefined {
  return stack[stack.length - 1];
}

function screenDepth(): number {
  return stack.filter((e) => !e.overlay).length;
}

function make<P>(Component: ComponentType<P>, props: P, overlay: boolean): Entry {
  return { id: nextId++, overlay, Component, props, handlers: [], softkeys: {}, onResume: [] };
}

export const router = {
  push<P>(Component: ComponentType<P>, props: P): void {
    stack = stack.concat(make(Component, props, false));
    changed();
  },

  /** An entry drawn over the current screen, which stays visible underneath. */
  overlay<P>(Component: ComponentType<P>, props: P): void {
    stack = stack.concat(make(Component, props, true));
    changed();
  },

  pop(): void {
    if (stack.length <= 1) return;
    lastPopAt = Date.now();
    stack = stack.slice(0, -1);
    changed();
    const t = topEntry();
    if (t) for (const fn of t.onResume.slice()) fn();
  },

  replace<P>(Component: ComponentType<P>, props: P): void {
    stack = stack.slice(0, -1).concat(make(Component, props, false));
    changed();
  },

  /** Clear the stack and start over at one screen. */
  reset<P>(Component: ComponentType<P>, props: P): void {
    stack = [make(Component, props, false)];
    changed();
  },

  depth(): number {
    return screenDepth();
  },

  has(Component: ComponentType<any>): boolean {
    return stack.some((e) => e.Component === Component);
  },

  /** Closes every entry showing `Component`, wherever it sits in the stack. */
  remove(Component: ComponentType<any>): void {
    const before = topEntry();
    const next = stack.filter((e) => e.Component !== Component);
    if (next.length === stack.length || !next.length) return;
    stack = next;
    changed();
    const t = topEntry();
    if (t && t !== before) for (const fn of t.onResume.slice()) fn();
  },
};

const EntryContext = createContext<Entry | null>(null);

function useEntry(): Entry {
  const e = useContext(EntryContext);
  if (!e) throw new Error('outside a router entry');
  return e;
}

/** True while this screen or overlay is on top of the stack. */
export function useIsTop(): boolean {
  const e = useEntry();
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }, []);
  return topEntry() === e;
}

/** Handle keys while this entry is on top. Handlers registered by child components run before their parents'; return true to stop. */
export function useKeys(handler: KeyHandler): void {
  const e = useEntry();
  const ref = useRef(handler);
  ref.current = handler;
  useLayoutEffect(() => {
    e.handlers.push(ref);
    return () => {
      const i = e.handlers.indexOf(ref);
      if (i >= 0) e.handlers.splice(i, 1);
    };
  }, [e]);
}

/** This entry's softkey labels. A pushed screen shows "Back" on the left unless it sets `left` (null hides it). */
export function useSoftkeys(labels: SoftkeyLabels): void {
  const e = useEntry();
  useLayoutEffect(() => {
    const prev = e.softkeys;
    if (prev.left === labels.left && prev.center === labels.center && prev.right === labels.right) return;
    e.softkeys = labels;
    if (topEntry() === e) changed();
  });
}

/** Run when this entry is uncovered again after the entry above it closes. */
export function useOnResume(fn: () => void): void {
  const e = useEntry();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const call = () => ref.current();
    e.onResume.push(call);
    return () => {
      const i = e.onResume.indexOf(call);
      if (i >= 0) e.onResume.splice(i, 1);
    };
  }, [e]);
}

function editingText(): boolean {
  const t = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.value.length > 0;
}

function onKeyDown(evt: KeyboardEvent): void {
  const e = topEntry();
  if (!e) return;
  for (const h of e.handlers.slice()) {
    if (h.current(evt)) {
      evt.preventDefault();
      evt.stopPropagation();
      return;
    }
  }
  const canGoBack = stack.length > 1;
  if (evt.key === 'SoftLeft' && canGoBack) {
    evt.preventDefault();
    router.pop();
    return;
  }
  if (evt.key === 'Backspace') {
    if (editingText()) return;
    if (canGoBack) {
      evt.preventDefault();
      router.pop();
    } else if (Date.now() - lastPopAt < EXIT_COOLDOWN_MS) {
      // Swallow a fast second Back right after returning to the first screen, so a double press doesn't close the app.
      evt.preventDefault();
    }
  }
}

/** The softkey labels to show now. */
export function currentSoftkeys(): SoftkeyLabels {
  const e = topEntry();
  if (!e) return {};
  const left = e.softkeys.left === undefined ? (stack.length > 1 && !e.overlay ? S.back : null) : e.softkeys.left;
  return { left, center: e.softkeys.center ?? null, right: e.softkeys.right ?? null };
}

export function useRouterVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const fn = () => setV((n) => n + 1);
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }, []);
  return v;
}

/* Re-renders only when its own entry changes, not on every push or pop. */
class EntryHost extends Component<{ entry: Entry }> {
  shouldComponentUpdate(next: { entry: Entry }): boolean {
    return next.entry !== this.props.entry;
  }

  render() {
    const e = this.props.entry;
    return (
      <EntryContext.Provider value={e}>
        <e.Component {...e.props} />
      </EntryContext.Provider>
    );
  }
}

/** Renders the stack. Screens below the top screen are hidden but stay mounted. */
export function RouterView() {
  useRouterVersion();
  useEffect(() => {
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
  let topScreen = stack.length - 1;
  while (topScreen > 0 && stack[topScreen].overlay) topScreen--;
  return (
    <div class="stack">
      {stack.map((e, i) => (
        <div key={e.id} class={'entry' + (e.overlay ? ' entry-overlay' : '') + (i < topScreen ? ' hidden' : '')}>
          <EntryHost entry={e} />
        </div>
      ))}
    </div>
  );
}

/** For render tests: the stack's current entries. */
export function _stackForTest(): Array<{ overlay: boolean; Component: ComponentType<any> }> {
  return stack.slice();
}
