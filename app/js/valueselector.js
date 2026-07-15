(function () {
  'use strict';

  /* Value selector (KaiOS "Value Selector" component): a list of options with
     radio (single) or checkbox (multiple) selection controls. Pushed onto the
     router stack like the generic menu.

     App.valueSelector.open({
       title,
       options: [{ label, value }],
       selected,           // single: a value; multiple: an array of values
       multiple,           // false (radio) by default
       onPick(value|array) // value for single, array for multiple (on Done)
     }) */

  App.valueSelector = {
    open: function (opts) {
      opts = opts || {};
      var multiple = !!opts.multiple;
      var options = opts.options || [];

      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', opts.title || ''));
      el.appendChild(hdr);

      var list = App.util.el('div', 'list');
      el.appendChild(list);

      var selSet = {};
      if (multiple && opts.selected && opts.selected.length) {
        opts.selected.forEach(function (v) { selSet[String(v)] = true; });
      }

      var startIdx = 0;
      options.forEach(function (o, i) {
        var row = App.util.el('div', 'opt-row');
        row.setAttribute('nav-selectable', 'true');
        row.setAttribute('data-id', String(i));
        row.appendChild(App.util.el('span', 'opt-label', o.label));
        row.appendChild(App.util.el('span', 'opt-mark' + (multiple ? ' check' : '')));
        row.__value = o.value;
        var on = multiple ? !!selSet[String(o.value)] : (o.value === opts.selected);
        if (on) {
          row.classList.add('on');
          if (!multiple) startIdx = i;
        }
        list.appendChild(row);
      });

      var nav = new App.Nav(el, { scrollEl: list });

      function commitMultiple() {
        var vals = [];
        var rows = list.querySelectorAll('.opt-row');
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].classList.contains('on')) vals.push(rows[i].__value);
        }
        if (opts.onPick) opts.onPick(vals);
      }

      function softkeys() {
        App.softkeys.set(multiple ? 'Done' : '', multiple ? 'Toggle' : 'Select', '');
      }

      App.router.push({
        el: el,
        enter: function () {
          softkeys();
          nav.select(startIdx);
        },
        resume: softkeys,
        onKey: function (evt) {
          if (nav.handleKey(evt)) return true;
          if (multiple && evt.key === 'SoftLeft') {
            App.router.pop();
            commitMultiple();
            return true;
          }
          if (evt.key === 'Enter') {
            var sel = nav.selected();
            if (!sel) return true;
            if (multiple) {
              if (sel.classList.contains('on')) sel.classList.remove('on');
              else sel.classList.add('on');
            } else {
              var value = sel.__value;
              App.router.pop();
              if (opts.onPick) opts.onPick(value);
            }
            return true;
          }
          return false;
        }
      });
    }
  };
})();
