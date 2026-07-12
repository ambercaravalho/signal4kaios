(function () {
  'use strict';

  /* Scan a QR code with the camera and the vendored jsQR decoder (global
     `jsQR`). Best-effort: camera / decoder support on Gecko 48 is uncertain, so
     if anything is missing we toast and pop. create(onResult) where onResult is
     called with the decoded string. */

  function supported() {
    if (typeof jsQR === 'undefined') return false;
    return !!((navigator.mediaDevices && navigator.mediaDevices.getUserMedia) ||
      navigator.getUserMedia || navigator.mozGetUserMedia ||
      navigator.webkitGetUserMedia);
  }

  function getStream() {
    var constraints = { video: { facingMode: 'environment' } };
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      return navigator.mediaDevices.getUserMedia(constraints);
    }
    var legacy = navigator.getUserMedia || navigator.mozGetUserMedia ||
      navigator.webkitGetUserMedia;
    return new Promise(function (resolve, reject) {
      legacy.call(navigator, constraints, resolve, reject);
    });
  }

  App.screens.scanqr = {
    create: function (onResult) {
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'Scan QR code'));
      el.appendChild(hdr);

      var box = App.util.el('div', 'viewer');
      var video = document.createElement('video');
      video.setAttribute('playsinline', 'true');
      video.autoplay = true;
      video.muted = true;
      box.appendChild(video);
      var status = App.util.el('div', 'viewer-status', 'Starting camera…');
      box.appendChild(status);
      el.appendChild(box);

      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d');
      var stream = null;
      var loopTimer = null;
      var scanning = false;
      var finished = false;

      function stopStream() {
        if (stream) {
          stream.getTracks().forEach(function (t) { t.stop(); });
          stream = null;
        }
      }

      function cleanup() {
        scanning = false;
        if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
        stopStream();
      }

      function fail(err) {
        App.util.dbg('scanqr failed: ' + (err && err.message));
        cleanup();
        App.toast('Scanning unavailable on this device');
        App.router.pop();
      }

      function done(text) {
        if (finished) return;
        finished = true;
        cleanup();
        App.router.pop();
        if (onResult) setTimeout(function () { onResult(text); }, 0);
      }

      function loop() {
        if (!scanning) return;
        try {
          if (video.readyState >= 2 && video.videoWidth) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            var code = jsQR(img.data, img.width, img.height);
            if (code && code.data) { done(code.data); return; }
          }
        } catch (e) {
          App.util.dbg('scan frame error: ' + e.message);
        }
        loopTimer = setTimeout(loop, 150);
      }

      function start() {
        getStream().then(function (s) {
          stream = s;
          try { video.srcObject = s; } catch (e) { video.src = URL.createObjectURL(s); }
          status.textContent = 'Point the camera at a QR code.';
          scanning = true;
          loop();
        })['catch'](fail);
      }

      return {
        el: el,
        enter: function () {
          if (!supported()) {
            App.toast('Scanning not supported on this device');
            App.router.pop();
            return;
          }
          App.softkeys.set('', '', 'Cancel');
          start();
        },
        destroy: cleanup,
        onKey: function (evt) {
          if (evt.key === 'SoftRight' || evt.key === 'Backspace') {
            cleanup();
            App.router.pop();
            return true;
          }
          return false;
        }
      };
    }
  };
})();
