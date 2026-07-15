(function () {
  'use strict';

  /* Screen-stack router. Screens are objects:
       { el, enter(), resume(), pause(), destroy(), onKey(evt) -> handled }
     Paused screens keep their (hidden) DOM so scroll/selection survives
     back-navigation. One global keydown listener dispatches to the top
     screen; unhandled Backspace pops the stack (KaiOS Back key sends
     Backspace — preventDefault or the system closes the app). */

  var stack = [];
  var container = null;

  function top() {
    return stack[stack.length - 1] || null;
  }

  /* Point the marquee at the current screen's header title (after a tick, so
     layout/measurement is settled). Long titles scroll iPod-style; short ones
     are left alone. */
  function refreshTitleMarquee() {
    if (!App.marquee) return;
    var s = top();
    var title = s && s.el ? s.el.querySelector('.hdr-title') : null;
    setTimeout(function () {
      if (top() === s) App.marquee.apply(title);
    }, 0);
  }

  function push(screen) {
    var cur = top();
    if (cur) {
      if (cur.pause) cur.pause();
      cur.el.classList.add('hidden');
    }
    stack.push(screen);
    container.appendChild(screen.el);
    if (screen.enter) screen.enter();
    refreshTitleMarquee();
  }

  function pop() {
    if (stack.length <= 1) return;
    var s = stack.pop();
    if (s.destroy) s.destroy();
    if (s.el.parentNode) s.el.parentNode.removeChild(s.el);
    var cur = top();
    if (cur) {
      cur.el.classList.remove('hidden');
      if (cur.resume) cur.resume();
    }
    refreshTitleMarquee();
  }

  function replace(screen) {
    var s = stack.pop();
    if (s) {
      if (s.destroy) s.destroy();
      if (s.el.parentNode) s.el.parentNode.removeChild(s.el);
    }
    push(screen);
  }

  function onKeyDown(evt) {
    // A modal dialog captures all keys above the screen stack.
    if (App.dialog && App.dialog.active()) {
      if (App.dialog.handleKey(evt)) {
        evt.preventDefault();
        evt.stopPropagation();
      }
      return;
    }

    var s = top();
    if (!s) return;

    if (s.onKey && s.onKey(evt)) {
      evt.preventDefault();
      evt.stopPropagation();
      return;
    }

    // Cohesive Back: the left softkey is Back on every pushed screen. When the
    // top screen doesn't claim SoftLeft for its own action, treat it like the
    // hardware Back key and pop.
    if (evt.key === 'SoftLeft' && stack.length > 1) {
      evt.preventDefault();
      evt.stopPropagation();
      pop();
      return;
    }

    if (evt.key === 'Backspace') {
      // Let Backspace edit non-empty text fields.
      var t = document.activeElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.value.length > 0) {
        return;
      }
      if (stack.length > 1) {
        evt.preventDefault();
        pop();
      }
      // On the root screen the default is allowed: KaiOS backgrounds/closes.
    }
  }

  App.router = {
    init: function (containerEl) {
      container = containerEl;
      document.addEventListener('keydown', onKeyDown);
    },
    push: push,
    pop: pop,
    replace: replace,
    top: top,
    depth: function () { return stack.length; }
  };
})();
