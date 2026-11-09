(function () {
  'use strict';

  /* Promise wrapper over XMLHttpRequest for direct communication with Signal servers.
     Uses mozSystem XHR on KaiOS 3.0 / 3.1 / 4.0 (privileged app: bypasses CORS for cross-origin requests to https://chat.signal.org and https://cdn.signal.org).

     Authenticated Signal requests carry Basic auth (`<aci>.<deviceId>:<password>`). A 401/403 on the active linked device means this device was unlinked from the primary phone: App.http.onUnpaired fires once so the app returns to the Link Device screen. */

  var unpairedFired = false;

  function makeXhr() {
    try {
      return new XMLHttpRequest({ mozSystem: true });
    } catch (e) {
      return new XMLHttpRequest();
    }
  }

  function encodeBasicAuth(username, password) {
    // SECURITY-REVIEW: Signal device credentials transmitted only over HTTPS Basic auth to Signal servers; never logged.
    return 'Basic ' + btoa(username + ':' + password);
  }

  /* opts: { timeout, binary, baseUrl, noAuth, basicAuth: { username, password }, headers: { ... } } */
  function request(method, path, body, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var base = (opts.baseUrl || App.config.serverUrl()).replace(/\/+$/, '');
      if (!base) {
        reject(new Error('Signal server address is not configured'));
        return;
      }

      var authHeader = '';
      var isActiveToken = false;
      if (opts.basicAuth && opts.basicAuth.username) {
        authHeader = encodeBasicAuth(opts.basicAuth.username, opts.basicAuth.password || '');
      } else if (!opts.noAuth && App.config.isConfigured()) {
        var login = (App.config.aci() || App.config.number()) + '.' + App.config.deviceId();
        authHeader = encodeBasicAuth(login, App.config.deviceToken());
        isActiveToken = true;
      }

      var xhr = makeXhr();
      xhr.open(method, base + path, true);
      xhr.timeout = opts.timeout || 15000;
      if (opts.binary) xhr.responseType = 'blob';
      if (authHeader) xhr.setRequestHeader('Authorization', authHeader);
      if (opts.headers) {
        Object.keys(opts.headers).forEach(function (k) {
          xhr.setRequestHeader(k, opts.headers[k]);
        });
      }
      xhr.setRequestHeader('X-Signal-Agent', 'OWD');

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
          var parsed = null;
          if (xhr.status === 401) msg += ': this phone is no longer linked to your Signal account';
          try {
            parsed = JSON.parse(xhr.responseText);
            if (parsed && parsed.error && xhr.status !== 401) msg += ': ' + parsed.error;
          } catch (e) { /* non-JSON error body */ }
          App.util.dbg('http fail ' + method + ' ' + path + ' -> ' + msg);
          if (xhr.status === 401 && isActiveToken && !unpairedFired && App.http.onUnpaired) {
            unpairedFired = true;
            App.http.onUnpaired();
          }
          var httpErr = new Error(msg);
          httpErr.kind = 'http';
          httpErr.status = xhr.status;
          httpErr.body = parsed;
          reject(httpErr);
        }
      };
      xhr.onerror = function () {
        App.util.dbg('http error ' + method + ' ' + path);
        var netErr = new Error('Network error (check internet connection)');
        netErr.kind = 'network';
        reject(netErr);
      };
      xhr.ontimeout = function () {
        App.util.dbg('http timeout ' + method + ' ' + path);
        var timeoutErr = new Error('Request timed out');
        timeoutErr.kind = 'timeout';
        reject(timeoutErr);
      };

      if (body != null) {
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify(body));
      } else {
        xhr.send();
      }
    });
  }

  /* Raw binary request (Signal CDN attachments, storage.signal.org protobufs). Resolves to { status, body: Uint8Array, location }; rejects on non-2xx with err.status set. */
  function rawRequest(method, url, bodyBytes, headers, timeout) {
    return new Promise(function (resolve, reject) {
      var xhr = makeXhr();
      xhr.open(method, url, true);
      xhr.timeout = timeout || 60000;
      xhr.responseType = 'arraybuffer';
      if (headers) {
        Object.keys(headers).forEach(function (k) {
          xhr.setRequestHeader(k, headers[k]);
        });
      }
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({
            status: xhr.status,
            body: xhr.response ? new Uint8Array(xhr.response) : new Uint8Array(0),
            location: xhr.getResponseHeader('Location')
          });
        } else {
          var err = new Error('HTTP ' + xhr.status);
          err.status = xhr.status;
          reject(err);
        }
      };
      xhr.onerror = function () { reject(new Error('Network error')); };
      xhr.ontimeout = function () { reject(new Error('Request timed out')); };
      if (bodyBytes) {
        xhr.send(bodyBytes);
      } else {
        xhr.send();
      }
    });
  }

  function rawBinary(method, url, bodyBytes, headers, timeout) {
    return rawRequest(method, url, bodyBytes, headers, timeout).then(function (res) { return res.body; });
  }

  App.http = {
    request: request,
    rawBinary: rawBinary,
    rawRequest: rawRequest,
    get: function (path, opts) { return request('GET', path, null, opts); },
    post: function (path, body, opts) { return request('POST', path, body, opts); },
    put: function (path, body, opts) { return request('PUT', path, body, opts); },
    del: function (path, body, opts) { return request('DELETE', path, body, opts); },
    onUnpaired: null
  };
})();
