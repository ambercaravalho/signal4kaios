(function () {
  'use strict';

  /* Generic single-field text entry screen. Reused for profile edit, contact
     rename, and starting a chat by number/username.

     create({ title, label, value?, placeholder?, hint?, note?, type?,
              submitLabel?, onSubmit(value, done) })

     onSubmit receives the trimmed value and a `done(errMsg)` callback: call
     done() to pop the screen, or done('message') to stay open and show an
     error. If onSubmit is synchronous it may return without using done — the
     screen pops unless it returns 'keep'. */

  App.screens.textinput = {
    create: function (opts) {
      opts = opts || {};
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', opts.title || ''));
      el.appendChild(hdr);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      var field = App.util.el('div', 'field');
      if (opts.label) field.appendChild(App.util.el('label', null, opts.label));
      var input = App.util.el('input');
      input.type = opts.type || 'text';
      if (opts.placeholder) input.placeholder = opts.placeholder;
      if (opts.value != null) input.value = opts.value;
      input.setAttribute('nav-selectable', 'true');
      input.setAttribute('data-id', '__input');
      field.appendChild(input);
      list.appendChild(field);

      if (opts.note) list.appendChild(App.util.el('div', 'field-note', opts.note));

      var status = App.util.el('div', 'status-line', opts.hint || '');
      list.appendChild(status);

      var submit = App.util.el('div', 'menu-item', opts.submitLabel || 'Save');
      submit.setAttribute('nav-selectable', 'true');
      submit.setAttribute('data-id', '__submit');
      list.appendChild(submit);

      var nav = new App.Nav(el, { scrollEl: list });
      var busy = false;

      function setStatus(msg, bad) {
        status.textContent = msg || '';
        status.className = 'status-line' + (bad ? ' bad' : '');
      }

      function done(err) {
        busy = false;
        if (err) {
          setStatus(err, true);
          nav.selectById('__input');
          return;
        }
        App.router.pop();
      }

      function submitNow() {
        if (busy) return;
        var value = input.value.replace(/^\s+|\s+$/g, '');
        if (!opts.onSubmit) {
          App.router.pop();
          return;
        }
        busy = true;
        setStatus('Working…', false);
        var ret = opts.onSubmit(value, done);
        // Synchronous handlers that don't use done() and don't keep open pop now.
        if (ret !== 'keep' && ret !== 'async') {
          busy = false;
          App.router.pop();
        }
      }

      return {
        el: el,
        enter: function () {
          App.softkeys.set('Back', opts.submitLabel || 'Save', '');
          nav.selectById('__input');
        },
        resume: function () {
          App.softkeys.set('Back', opts.submitLabel || 'Save', '');
        },
        onKey: function (evt) {
          var inInput = document.activeElement === input;
          if (inInput && (evt.key === 'ArrowLeft' || evt.key === 'ArrowRight')) {
            return false; // move the text cursor
          }
          if (nav.handleKey(evt)) return true;
          if (evt.key === 'Enter') {
            var sel = nav.selected();
            if (sel === input) {
              nav.selectById('__submit');
              submitNow();
              return true;
            }
            if (sel === submit) {
              submitNow();
              return true;
            }
          }
          return false;
        }
      };
    }
  };
})();
