(function () {
  'use strict';

  /* Native-style modal dialog (KaiOS "Dialog" component). Renders a scrim +
     centered card in the #overlay layer, over the live screen. While open it is
     modal: the router routes every key here first (see router.js), so the
     screen beneath never sees them. Actions are driven by the softkeys:
       SoftRight / Center-Enter -> confirm,  SoftLeft / Back -> cancel.

     App.dialog.confirm({ title, message, confirmLabel, onConfirm, onCancel }) */

  var scrim = null;
  var state = null;

  function overlayEl() {
    return document.getElementById('overlay');
  }

  /* Softkeys belong to the screen underneath, so snapshot and restore them
     around the dialog rather than asking that screen to re-render. */
  function snapshot() {
    var c = document.getElementById('sk-center');
    return {
      l: document.getElementById('sk-left').textContent,
      c: c.textContent,
      cls: c.className,
      r: document.getElementById('sk-right').textContent
    };
  }

  function restore(s) {
    document.getElementById('sk-left').textContent = s.l;
    var c = document.getElementById('sk-center');
    c.textContent = s.c;
    c.className = s.cls;
    document.getElementById('sk-right').textContent = s.r;
  }

  function teardown() {
    var prev = state ? state.prev : null;
    if (scrim && scrim.parentNode) scrim.parentNode.removeChild(scrim);
    scrim = null;
    state = null;
    if (prev) restore(prev);
  }

  App.dialog = {
    confirm: function (opts) {
      opts = opts || {};
      // Only one dialog at a time; replace any that is already showing.
      if (state) teardown();

      var prev = snapshot();
      scrim = App.util.el('div', 'dialog-scrim');
      var card = App.util.el('div', 'dialog-card');
      card.appendChild(App.util.el('div', 'dialog-title', opts.title || ''));
      if (opts.message) {
        card.appendChild(App.util.el('div', 'dialog-msg', opts.message));
      }
      scrim.appendChild(card);
      overlayEl().appendChild(scrim);

      App.softkeys.set('Cancel', opts.confirmLabel || 'OK', '');
      state = {
        onConfirm: opts.onConfirm || null,
        onCancel: opts.onCancel || null,
        prev: prev
      };
    },

    active: function () {
      return !!state;
    },

    /* Called by the router before the active screen. Returns true for every
       key so the dialog stays modal. */
    handleKey: function (evt) {
      if (!state) return false;
      var cb = null;
      if (evt.key === 'Enter' || evt.key === 'SoftRight') {
        cb = state.onConfirm;
      } else if (evt.key === 'SoftLeft' || evt.key === 'Backspace') {
        cb = state.onCancel;
      } else {
        return true; // swallow arrows etc. — modal
      }
      teardown();
      if (cb) cb();
      return true;
    }
  };
})();
