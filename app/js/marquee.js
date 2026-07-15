(function () {
  'use strict';

  /* iPod-style back-and-forth scroll for a single overflowing element (used for
     long header titles). Only one element scrolls at a time — the router points
     this at the current screen's title on enter/resume. When the text fits, the
     element is left untouched (centered/ellipsized as its CSS dictates).

     Driven by scrollLeft on a timer rather than a CSS keyframe: the scroll
     distance depends on the measured text width, and animating scrollLeft is
     CSP-safe and reliable on Gecko 48. */

  var STEP = 1;        // px moved per tick
  var TICK_MS = 40;    // ~25 fps
  var END_PAUSE = 28;  // ticks paused at each end (~1.1s)

  var timer = null;
  var curEl = null;

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (curEl) {
      curEl.classList.remove('marquee');
      curEl.scrollLeft = 0;
      curEl = null;
    }
  }

  function apply(el) {
    stop();
    if (!el) return;
    el.classList.remove('marquee');
    el.scrollLeft = 0;
    var overflow = el.scrollWidth - el.clientWidth;
    if (overflow <= 2) return; // fits: nothing to scroll

    el.classList.add('marquee');
    curEl = el;

    var pos = 0;
    var dir = 1;
    var pause = END_PAUSE;
    timer = setInterval(function () {
      if (!curEl) return;
      if (pause > 0) { pause -= 1; return; }
      pos += dir * STEP;
      if (pos >= overflow) { pos = overflow; dir = -1; pause = END_PAUSE; }
      else if (pos <= 0) { pos = 0; dir = 1; pause = END_PAUSE; }
      curEl.scrollLeft = pos;
    }, TICK_MS);
  }

  App.marquee = { apply: apply, stop: stop };
})();
