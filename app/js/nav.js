(function () {
  'use strict';

  /* Per-screen D-pad navigation, ported from the KaiOS demo's useNavigation
     pattern: focusable elements carry nav-selectable; the current one gets
     nav-selected="true" (styled via CSS attribute selectors). Each screen
     owns one Nav instance scoped to its root element.

     opts: { scrollEl, wrap (default true), cols (default 1),
             onChange(el, index) } */

  function Nav(root, opts) {
    opts = opts || {};
    this.root = root;
    this.scrollEl = opts.scrollEl || root;
    this.wrap = opts.wrap !== false;
    this.cols = opts.cols || 1;
    this.onChange = opts.onChange || null;
    this.activeId = null;
  }

  Nav.prototype.items = function () {
    return this.root.querySelectorAll('[nav-selectable]');
  };

  Nav.prototype.selectedIndex = function () {
    var items = this.items();
    for (var i = 0; i < items.length; i++) {
      if (items[i].getAttribute('nav-selected') === 'true') return i;
    }
    return -1;
  };

  Nav.prototype.selected = function () {
    return this.root.querySelector('[nav-selected="true"]');
  };

  Nav.prototype.select = function (index) {
    var items = this.items();
    if (!items.length) return;
    if (index < 0) index = 0;
    if (index > items.length - 1) index = items.length - 1;
    var target = items[index];
    for (var i = 0; i < items.length; i++) {
      items[i].setAttribute('nav-selected', items[i] === target ? 'true' : 'false');
    }
    this.activeId = target.getAttribute('data-id');
    var tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      target.focus();
    } else if (document.activeElement &&
      (document.activeElement.tagName === 'INPUT' ||
        document.activeElement.tagName === 'TEXTAREA')) {
      document.activeElement.blur();
    }
    // At the ends of the list, snap the scroll container fully to the top or
    // bottom so non-selectable content there (section headers above the first
    // item, a status/hint line below the last) becomes visible — otherwise
    // wrapping back to the first item would leave the header scrolled off.
    if (index <= 0 && this.scrollEl) {
      this.scrollEl.scrollTop = 0;
    } else if (index >= items.length - 1 && this.scrollEl) {
      this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
    } else {
      this.ensureVisible(target);
    }
    if (this.onChange) this.onChange(target, index);
  };

  Nav.prototype.selectById = function (id) {
    var items = this.items();
    for (var i = 0; i < items.length; i++) {
      if (items[i].getAttribute('data-id') === id) {
        this.select(i);
        return true;
      }
    }
    return false;
  };

  Nav.prototype.selectLast = function () {
    this.select(this.items().length - 1);
  };

  /* Re-apply selection after a list re-render: prefer the remembered
     data-id, else clamp the previous index. */
  Nav.prototype.refresh = function () {
    if (this.activeId && this.selectById(this.activeId)) return;
    var idx = this.selectedIndex();
    this.select(idx < 0 ? 0 : idx);
  };

  Nav.prototype.move = function (delta) {
    var items = this.items();
    if (!items.length) return false;
    var cur = this.selectedIndex();
    if (cur < 0) {
      this.select(0);
      return true;
    }
    var next = cur + delta;
    if (next < 0) {
      if (!this.wrap) return false;
      next = items.length - 1;
    } else if (next > items.length - 1) {
      if (!this.wrap) return false;
      next = 0;
    }
    this.select(next);
    return true;
  };

  Nav.prototype.handleKey = function (evt) {
    switch (evt.key) {
      case 'ArrowDown':
        return this.move(this.cols);
      case 'ArrowUp':
        return this.move(-this.cols);
      case 'ArrowLeft':
        return this.cols > 1 ? this.move(-1) : false;
      case 'ArrowRight':
        return this.cols > 1 ? this.move(1) : false;
      default:
        return false;
    }
  };

  Nav.prototype.ensureVisible = function (elm) {
    var c = this.scrollEl;
    if (!c || c === elm) return;
    var top = elm.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop;
    var bottom = top + elm.offsetHeight;
    if (top < c.scrollTop) {
      c.scrollTop = top;
    } else if (bottom > c.scrollTop + c.clientHeight) {
      c.scrollTop = bottom - c.clientHeight;
    }
  };

  App.Nav = Nav;
})();
