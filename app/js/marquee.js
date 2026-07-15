(function () {
  'use strict';

  /* iPod-style back-and-forth scroll for an overflowing element (long header
     titles, and the highlighted conversation row's name). State lives on the
     element itself (`__mqTimer`), so any number can run independently and each
     self-cleans when its node leaves the DOM.

     Driven by scrollLeft on a timer rather than a CSS keyframe: the distance
     depends on the measured text width, and animating scrollLeft is CSP-safe
     and reliable on Gecko 48. Callers stop marquees they no longer want (e.g.
     on pause) to keep only the visible one running. */

  var STEP = 1;        // px moved per tick
  var TICK_MS = 40;    // ~25 fps
  var END_PAUSE = 28;  // ticks paused at each end (~1.1s)

  /* Scroll position keyed by the element's text, so a node that is destroyed
     and re-created with the same label (e.g. the conversation list rebuilding
     on every incoming message) resumes where it left off instead of snapping
     back to the start. Bounded so it can't grow without limit. */
  var cache = {};
  var cacheKeys = 0;

  function keyOf(el) { return el.textContent || ''; }

  function remember(el) {
    if (!el.__mqState) return;
    if (cacheKeys > 60) { cache = {}; cacheKeys = 0; }
    if (!cache.hasOwnProperty(keyOf(el))) cacheKeys += 1;
    cache[keyOf(el)] = el.__mqState;
  }

  function stop(el) {
    if (!el) return;
    if (el.__mqTimer) {
      clearInterval(el.__mqTimer);
      el.__mqTimer = null;
      remember(el); // save progress for a same-text node created later
    }
    el.classList.remove('marquee');
    el.scrollLeft = 0;
  }

  function apply(el) {
    if (!el) return;
    stop(el);
    var overflow = el.scrollWidth - el.clientWidth;
    if (overflow <= 2) return; // fits: nothing to scroll

    el.classList.add('marquee');
    var saved = cache[keyOf(el)];
    var st = {
      pos: saved ? Math.min(saved.pos, overflow) : 0,
      dir: saved ? saved.dir : 1,
      pause: saved ? saved.pause : END_PAUSE
    };
    el.__mqState = st;
    el.scrollLeft = st.pos;
    el.__mqTimer = setInterval(function () {
      if (!el.parentNode) { stop(el); return; } // node removed: self-clean
      if (st.pause > 0) { st.pause -= 1; return; }
      st.pos += st.dir * STEP;
      if (st.pos >= overflow) { st.pos = overflow; st.dir = -1; st.pause = END_PAUSE; }
      else if (st.pos <= 0) { st.pos = 0; st.dir = 1; st.pause = END_PAUSE; }
      el.scrollLeft = st.pos;
    }, TICK_MS);
  }

  App.marquee = { apply: apply, stop: stop };
})();
