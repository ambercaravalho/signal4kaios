(function () {
  'use strict';

  /* Tab strip (KaiOS "Tab" component): sits below the header and lets the user
     switch grouped content with the Left/Right D-pad keys. Presentational —
     the owning screen decides what each pane shows via the onChange callback.

     var tabs = App.tabs.create(['Chats', 'Archived'], onChange);
     Append tabs.el after the header, then the list. In the screen's onKey,
     call tabs.handleKey(evt) before the list nav. */

  App.tabs = {
    create: function (labels, onChange) {
      var el = App.util.el('div', 'tabs');
      var tabEls = [];
      labels.forEach(function (label, i) {
        var t = App.util.el('div', 'tab' + (i === 0 ? ' sel' : ''), label);
        el.appendChild(t);
        tabEls.push(t);
      });
      var index = 0;

      function set(i) {
        if (i < 0 || i > tabEls.length - 1 || i === index) return;
        tabEls[index].classList.remove('sel');
        index = i;
        tabEls[index].classList.add('sel');
        if (onChange) onChange(index);
      }

      return {
        el: el,
        index: function () { return index; },
        set: set,
        /* Consume Left/Right (they only move between tabs here); clamps at the
           ends. Returns true when the key was a tab key. */
        handleKey: function (evt) {
          if (evt.key === 'ArrowLeft') { set(index - 1); return true; }
          if (evt.key === 'ArrowRight') { set(index + 1); return true; }
          return false;
        }
      };
    }
  };
})();
