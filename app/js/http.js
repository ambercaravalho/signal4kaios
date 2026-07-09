(function () {
  'use strict';

  /* Promise wrapper over XMLHttpRequest. Uses mozSystem XHR when available
     (privileged KaiOS app: bypasses CORS for cross-origin requests to the
     signal-cli-rest-api server); falls back to a plain XHR so the app can be
     developed in a desktop browser behind a CORS proxy. */

  function makeXhr() {
    try {
      var x = new XMLHttpRequest({ mozSystem: true });
      // Browsers without mozSystem support just ignore the option.
      return x;
    } catch (e) {
      return new XMLHttpRequest();
    }
  }

  function request(method, path, body, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var base = App.config.serverUrl();
      if (!base) {
        reject(new Error('Server URL is not configured'));
        return;
      }
      var xhr = makeXhr();
      xhr.open(method, base + path, true);
      xhr.timeout = opts.timeout || 15000;
      if (opts.binary) xhr.responseType = 'blob';

      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          if (opts.binary) {
            resolve(xhr.response);
            return;
          }
          var text = xhr.responseText;
          if (!text) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            resolve(text);
          }
        } else {
          var msg = 'HTTP ' + xhr.status;
          try {
            var parsed = JSON.parse(xhr.responseText);
            if (parsed && parsed.error) msg += ': ' + parsed.error;
          } catch (e) { /* non-JSON error body */ }
          App.util.dbg('http fail ' + method + ' ' + path + ' -> ' + msg);
          reject(new Error(msg));
        }
      };
      xhr.onerror = function () {
        App.util.dbg('http error ' + method + ' ' + path);
        reject(new Error('Network error (is the server reachable?)'));
      };
      xhr.ontimeout = function () {
        App.util.dbg('http timeout ' + method + ' ' + path);
        reject(new Error('Request timed out'));
      };

      if (body != null) {
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify(body));
      } else {
        xhr.send();
      }
    });
  }

  App.http = {
    request: request,
    get: function (path, opts) { return request('GET', path, null, opts); },
    post: function (path, body, opts) { return request('POST', path, body, opts); },
    put: function (path, body, opts) { return request('PUT', path, body, opts); },
    del: function (path, body, opts) { return request('DELETE', path, body, opts); }
  };
})();
