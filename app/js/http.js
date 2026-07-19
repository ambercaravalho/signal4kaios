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

  /* HTTP Basic Auth header for a reverse proxy in front of the server (used
     only in the 'basic' auth mode). Set explicitly so the request is
     authenticated on the first try, without depending on a 401 challenge. */
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

  /* In 'token' auth mode the receive token is sent as a query param on every
     request, so the same secret authenticates both the API and (in ws.js) the
     receive WebSocket. Returns the URL with the param appended, or the URL
     unchanged if no token is set. */
  function withToken(url) {
    var token = App.config.receiveToken();
    if (!token) return url;
    var param = App.config.tokenParam();
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    return url + sep + encodeURIComponent(param) + '=' + encodeURIComponent(token);
  }

  function request(method, path, body, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var base = App.config.serverUrl();
      if (!base) {
        reject(new Error('Server URL is not configured'));
        return;
      }
      var mode = App.config.authMode();
      var xhr = makeXhr();
      // Build the URL first so the token param (if any) is never in the logged
      // `path`. The Authorization header is only used in 'basic' mode.
      var url = base + path;
      var authHeader = null;
      if (mode === 'token') {
        url = withToken(url);
      } else if (mode === 'basic') {
        authHeader = basicAuthHeader();
      }
      xhr.open(method, url, true);
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
          if (xhr.status === 401 || xhr.status === 403) {
            if (mode === 'basic') {
              msg += ' — check the proxy username/password in Settings';
            } else if (mode === 'token') {
              msg += ' — check the receive token and its param name in Settings';
            } else {
              msg += ' — the server needs authentication (set it in Settings)';
            }
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
