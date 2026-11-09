(function () {
  'use strict';

  var timer = null;

  App.toast = function (msg, ms) {
    var box = document.getElementById('toast');
    if (!box) return;
    box.textContent = msg;
    box.classList.remove('hidden');
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      box.classList.add('hidden');
      timer = null;
    }, ms || 2500);
  };
})();
