/* D-pad focus for lists and grids, and the scroll that keeps the focused item in view. */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useIsTop, useKeys } from './router';

/** True while the user is typing in a text field, where arrow and Back keys belong to the field. */
export function isTyping(): boolean {
  const t = document.activeElement;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
}

export interface ListNav {
  index: number;
  setIndex(i: number): void;
}

/** Up and Down move through `count` items and wrap at the ends, like KaiOS lists; with `cols`, Left and Right move within a row of a grid. Enter calls `onEnter`. */
export function useListNav(opts: { count: number; cols?: number; wrap?: boolean; initial?: number; onEnter?: (i: number) => void; enabled?: boolean }): ListNav {
  const { count, cols = 1, wrap = true, onEnter, enabled = true } = opts;
  const [index, setIndexRaw] = useState(opts.initial || 0);
  const clamped = count ? Math.min(Math.max(index, 0), count - 1) : 0;

  useKeys((e) => {
    if (!enabled || !count) return false;
    const textarea = (document.activeElement as HTMLElement | null)?.tagName === 'TEXTAREA';
    let step = 0;
    if (e.key === 'ArrowDown' && !textarea) step = cols;
    else if (e.key === 'ArrowUp' && !textarea) step = -cols;
    else if (cols > 1 && e.key === 'ArrowRight') step = 1;
    else if (cols > 1 && e.key === 'ArrowLeft') step = -1;
    else if (e.key === 'Enter' && onEnter) {
      onEnter(clamped);
      return true;
    } else return false;
    let next = clamped + step;
    if (next < 0 || next >= count) {
      if (!wrap) return true;
      const col = clamped % cols;
      const vertical = cols > 1 && Math.abs(step) === cols;
      if (vertical) next = step > 0 ? col : Math.min(Math.floor((count - 1) / cols) * cols + col, count - 1);
      else next = step > 0 ? 0 : count - 1;
    }
    setIndexRaw(next);
    return true;
  });

  return { index: clamped, setIndex: setIndexRaw };
}

const SCROLLERS = '.body, .sheet-body, .chat-list, .dialog-body';

/** Scroll the nearest scrolling container just enough to show `from` through `to`. `scrollIntoView` would also scroll the stack and `#app`, which slides the whole screen while a menu animates in. */
function revealInScroller(from: HTMLElement, to: HTMLElement = from): void {
  const box = from.closest(SCROLLERS) as HTMLElement | null;
  if (!box) return;
  const view = box.getBoundingClientRect();
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  if (b.bottom > view.bottom) box.scrollTop += Math.min(b.bottom - view.bottom, a.top - view.top);
  else if (a.top < view.top) box.scrollTop -= view.top - a.top;
}

/** Scroll back to the very top when that still shows `el`, so content above a list's first row (a profile header) comes back into view. */
function scrollToTopIfFits(el: HTMLElement): boolean {
  const box = el.closest(SCROLLERS) as HTMLElement | null;
  if (!box) return false;
  const bottomFromTop = el.getBoundingClientRect().bottom - box.getBoundingClientRect().top + box.scrollTop;
  if (bottomFromTop > box.clientHeight) return false;
  box.scrollTop = 0;
  return true;
}

/** A ref that scrolls its element into view when it gains focus, along with a section separator just above it. With `first`, it scrolls to the top of the list instead when the element fits there. */
export function useFocusScroll<T extends HTMLElement>(focused: boolean, first = false): { current: T | null } {
  const ref = useRef<T>(null);
  const top = useIsTop();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !focused || !top) return;
    if (first && scrollToTopIfFits(el)) return;
    const prev = el.previousElementSibling as HTMLElement | null;
    revealInScroller(prev && prev.classList.contains('sep') ? prev : el, el);
  }, [focused, top, first]);
  return ref;
}

const MARQUEE_TICK_MS = 40;
const MARQUEE_PAUSE_TICKS = 28;

/** Scroll an overflowing single-line element back and forth while `active`, like KaiOS's focused list rows. Driven by scrollLeft because the distance depends on measured width and the CSP forbids generated CSS. */
export function useMarquee<T extends HTMLElement>(active: boolean, text: string): { current: T | null } {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollLeft = 0;
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = setTimeout(() => {
      const overflow = el.scrollWidth - el.clientWidth;
      if (overflow <= 2) return;
      let pos = 0;
      let dir = 1;
      let pause = MARQUEE_PAUSE_TICKS;
      timer = setInterval(() => {
        if (pause > 0) {
          pause -= 1;
          return;
        }
        pos += dir;
        if (pos >= overflow) {
          pos = overflow;
          dir = -1;
          pause = MARQUEE_PAUSE_TICKS;
        } else if (pos <= 0) {
          pos = 0;
          dir = 1;
          pause = MARQUEE_PAUSE_TICKS;
        }
        el.scrollLeft = pos;
      }, MARQUEE_TICK_MS);
    }, 0);
    return () => {
      clearTimeout(start);
      if (timer) clearInterval(timer);
      el.scrollLeft = 0;
    };
  }, [active, text]);
  return ref;
}
