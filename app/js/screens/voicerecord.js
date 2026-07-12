(function () {
  'use strict';

  /* Record a voice message with getUserMedia + MediaRecorder and send it as an
     audio attachment. Gecko 48 support for these APIs is uncertain, so if they
     are missing we fall back to the file picker. create(convId, opts) where
     opts = { caption, fallback }. */

  function supported() {
    if (typeof MediaRecorder === 'undefined') return false;
    return !!((navigator.mediaDevices && navigator.mediaDevices.getUserMedia) ||
      navigator.getUserMedia || navigator.mozGetUserMedia ||
      navigator.webkitGetUserMedia);
  }

  function getStream() {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    var legacy = navigator.getUserMedia || navigator.mozGetUserMedia ||
      navigator.webkitGetUserMedia;
    return new Promise(function (resolve, reject) {
      legacy.call(navigator, { audio: true }, resolve, reject);
    });
  }

  App.screens.voicerecord = {
    create: function (convId, opts) {
      opts = opts || {};
      var el = App.util.el('div', 'screen');
      var hdr = App.util.el('div', 'hdr');
      hdr.appendChild(App.util.el('span', 'hdr-title', 'Voice message'));
      el.appendChild(hdr);
      var box = App.util.el('div', 'viewer');
      var status = App.util.el('div', 'viewer-status', 'Starting microphone…');
      box.appendChild(status);
      el.appendChild(box);

      var stream = null;
      var recorder = null;
      var chunks = [];
      var startedAt = 0;
      var timer = null;
      var sending = false;
      var cancelled = false;
      var done = false;

      function elapsed() {
        var secs = Math.floor((Date.now() - startedAt) / 1000);
        return App.util.pad2(Math.floor(secs / 60)) + ':' + App.util.pad2(secs % 60);
      }

      function tick() {
        status.textContent = '\u25CF Recording ' + elapsed() +
          '\nCenter: send \u00B7 Back: cancel';
      }

      function stopTracks() {
        if (stream) {
          stream.getTracks().forEach(function (t) { t.stop(); });
          stream = null;
        }
      }

      function cleanup() {
        if (timer) { clearInterval(timer); timer = null; }
        stopTracks();
      }

      function fail(err) {
        App.util.dbg('voice record failed: ' + (err && err.message));
        cleanup();
        App.toast('Recording unavailable; pick a file instead');
        App.router.pop();
        if (opts.fallback) opts.fallback();
      }

      function finishSend() {
        if (done) return;
        done = true;
        stopTracks();
        if (cancelled) return;
        var blob = new Blob(chunks,
          { type: (recorder && recorder.mimeType) || 'audio/ogg' });
        if (!blob.size) {
          App.toast('Nothing recorded');
          App.router.pop();
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          var type = blob.type || 'audio/ogg';
          App.store.sendAttachment(convId, reader.result, opts.caption || '', {
            contentType: type, filename: 'voice-message', size: blob.size
          })['catch'](function (err) {
            App.toast('Send failed: ' + err.message);
          });
          App.router.pop();
        };
        reader.onerror = function () {
          App.toast('Could not encode audio');
          App.router.pop();
        };
        reader.readAsDataURL(blob);
      }

      function start() {
        getStream().then(function (s) {
          stream = s;
          try {
            recorder = new MediaRecorder(s);
          } catch (e) {
            fail(e);
            return;
          }
          recorder.ondataavailable = function (e) {
            if (e.data && e.data.size) chunks.push(e.data);
          };
          recorder.onstop = finishSend;
          recorder.start();
          startedAt = Date.now();
          timer = setInterval(tick, 500);
          tick();
          App.softkeys.set('', 'Send', 'Cancel');
        })['catch'](fail);
      }

      function stopAndSend() {
        if (sending) return;
        sending = true;
        if (timer) { clearInterval(timer); timer = null; }
        if (recorder && recorder.state !== 'inactive') recorder.stop();
        else finishSend();
      }

      function cancel() {
        cancelled = true;
        if (timer) { clearInterval(timer); timer = null; }
        if (recorder && recorder.state !== 'inactive') {
          try { recorder.stop(); } catch (e) { /* ignore */ }
        }
        stopTracks();
        App.router.pop();
      }

      return {
        el: el,
        enter: function () {
          if (!supported()) {
            App.toast('Recording not supported; pick a file instead');
            App.router.pop();
            if (opts.fallback) opts.fallback();
            return;
          }
          App.softkeys.set('', 'Send', 'Cancel');
          start();
        },
        destroy: cleanup,
        onKey: function (evt) {
          if (evt.key === 'Enter') { stopAndSend(); return true; }
          if (evt.key === 'SoftRight' || evt.key === 'Backspace') {
            cancel();
            return true;
          }
          return false;
        }
      };
    }
  };
})();
