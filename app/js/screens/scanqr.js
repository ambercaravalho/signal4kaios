(function () {
  'use strict';

  /* Scan a QR code and decode it with the vendored jsQR decoder (global `jsQR`).
     create(onResult) -> onResult is called with the decoded string.

     Two paths, because camera support varies across KaiOS 2.5 builds:
       1. Live preview via getUserMedia (needs the `video-capture` permission).
          Smoothest, but not every device grants a raw stream to a privileged
          (non-certified) app.
       2. Fallback: a MozActivity 'pick' snapshot — the OS camera takes one
          photo, which we then decode. This reuses the system camera app, so it
          works wherever the file/photo picker does. */

  function liveSupported() {
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

  /* Decode a still image Blob. Resolves with the QR text or null if none found. */
  function decodeBlob(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          var data = ctx.getImageData(0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          var code = jsQR(data.data, data.width, data.height);
          resolve(code && code.data ? code.data : null);
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read the photo'));
      };
      img.src = url;
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
        if (!finished) { finished = true; App.router.pop(); }
      }

      function done(text) {
        if (finished) return;
        finished = true;
        cleanup();
        App.router.pop();
        if (onResult) setTimeout(function () { onResult(text); }, 0);
      }

      /* Snapshot fallback: hand off to the OS camera via a 'pick' activity,
         then decode the returned photo. Works wherever the photo picker does. */
      function snapFallback() {
        if (typeof MozActivity === 'undefined') {
          fail(new Error('no camera stream and no MozActivity'));
          return;
        }
        cleanup();
        status.textContent = 'Opening camera…';
        var act;
        try {
          act = new MozActivity({ name: 'pick', data: { type: ['image/*'] } });
        } catch (e) { fail(e); return; }
        act.onsuccess = function () {
          var blob = this.result && this.result.blob;
          if (!blob) { if (!finished) { finished = true; App.router.pop(); } return; }
          status.textContent = 'Reading QR code…';
          decodeBlob(blob).then(function (text) {
            if (text) { done(text); return; }
            App.toast('No QR code found in that photo');
            if (!finished) { finished = true; App.router.pop(); }
          })['catch'](fail);
        };
        act.onerror = function () {
          // User backed out of the camera.
          if (!finished) { finished = true; App.router.pop(); }
        };
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

      function startLive() {
        getStream().then(function (s) {
          if (finished) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
          stream = s;
          try { video.srcObject = s; } catch (e) { video.src = URL.createObjectURL(s); }
          status.textContent = 'Point the camera at a QR code.';
          scanning = true;
          loop();
        })['catch'](function (err) {
          // Stream denied/unavailable — fall back to a snapshot.
          App.util.dbg('scanqr live stream failed: ' + (err && err.message));
          snapFallback();
        });
      }

      return {
        el: el,
        enter: function () {
          if (typeof jsQR === 'undefined') {
            App.toast('QR decoder failed to load');
            App.router.pop();
            return;
          }
          App.softkeys.set('Back', '', '');
          if (liveSupported()) startLive();
          else snapFallback();
        },
        destroy: cleanup,
        onKey: function (evt) {
          if (evt.key === 'SoftLeft' || evt.key === 'Backspace') {
            if (!finished) { finished = true; cleanup(); App.router.pop(); }
            return true;
          }
          return false;
        }
      };
    }
  };
})();
