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

  /* HTTP Basic Auth for reverse proxies (e.g. Pangolin "header auth") in
     front of the signal-cli-rest-api server. Two things happen together:
     - The Authorization header is set explicitly, so this request is
       authenticated on the first try (no dependency on a 401 challenge).
     - Passing the same username/password to xhr.open() teaches Gecko's own
       HTTP auth cache for this origin, which is what lets the WebSocket
       handshake (an HTTP request the app cannot attach headers to) ride
       along on cached credentials — see ws.js's auth-priming step. */
  function basicAuthHeader() {
    var user = App.config.authUser();
    if (!user) return null;
    try {
      return 'Basic ' + btoa(user + ':' + App.config.authPass());
    } catch (e) {
      App.util.dbg('basic auth: could not encode credentials — ' + e.message);
      return null;
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
      var authHeader = basicAuthHeader();
      if (authHeader) {
        xhr.open(method, base + path, true, App.config.authUser(), App.config.authPass());
      } else {
        xhr.open(method, base + path, true);
      }
      xhr.timeout = opts.timeout || 15000;
      if (opts.binary) xhr.responseType = 'blob';
      if (authHeader) xhr.setRequestHeader('Authorization', authHeader);

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
          if (xhr.status === 401) {
            msg += ' — check the auth username/password in Settings';
          }
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
