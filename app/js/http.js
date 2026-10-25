(function () {
  'use strict';

  /* Promise wrapper over XMLHttpRequest. Uses mozSystem XHR when available (privileged KaiOS app: bypasses CORS for cross-origin requests to the gateway); falls back to a plain XHR so the app can be developed in a desktop browser behind a CORS proxy.

     Every request carries the paired device token as Authorization: Bearer. A 401 means the gateway no longer knows this phone (revoked, or the gateway's data was reset): App.http.onUnpaired fires once so the app can send the user back to pairing. */

  var unpairedFired = false;

  function makeXhr() {
    try {
      var x = new XMLHttpRequest({ mozSystem: true });
      // Browsers without mozSystem support just ignore the option.
      return x;
    } catch (e) {
      return new XMLHttpRequest();
    }
  }

  /* opts: { timeout, binary, baseUrl (override the configured server, for pairing), noAuth (skip the configured token), authToken (send this token instead) } */
  function request(method, path, body, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var base = (opts.baseUrl || App.config.serverUrl()).replace(/\/+$/, '');
      if (!base) {
        reject(new Error('Gateway address is not configured'));
        return;
      }
      var token = opts.authToken || (opts.noAuth ? '' : App.config.deviceToken());
      // Only the active pairing can trigger the global "unpaired" handling.
      var isActiveToken = !opts.noAuth && !opts.authToken;
      var xhr = makeXhr();
      xhr.open(method, base + path, true);
      xhr.timeout = opts.timeout || 15000;
      if (opts.binary) xhr.responseType = 'blob';
      if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);

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
          if (xhr.status === 401) msg += ': this phone is not paired with the gateway';
          try {
            var parsed = JSON.parse(xhr.responseText);
            if (parsed && parsed.error && xhr.status !== 401) msg += ': ' + parsed.error;
          } catch (e) { /* non-JSON error body */ }
          App.util.dbg('http fail ' + method + ' ' + path + ' -> ' + msg);
          if (xhr.status === 401 && token && isActiveToken && !unpairedFired && App.http.onUnpaired) {
            unpairedFired = true;
            App.http.onUnpaired();
          }
          var httpErr = new Error(msg);
          httpErr.kind = 'http';
          httpErr.status = xhr.status;
          reject(httpErr);
        }
      };
      xhr.onerror = function () {
        App.util.dbg('http error ' + method + ' ' + path);
        var netErr = new Error('Network error (is the server reachable?)');
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

  App.http = {
    request: request,
    get: function (path, opts) { return request('GET', path, null, opts); },
    post: function (path, body, opts) { return request('POST', path, body, opts); },
    put: function (path, body, opts) { return request('PUT', path, body, opts); },
    del: function (path, body, opts) { return request('DELETE', path, body, opts); },
    // Set by main.js: called once when the gateway rejects our device token.
    onUnpaired: null
  };
})();
