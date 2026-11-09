(function () {
  'use strict';

  /* Promise wrapper for direct communication with Signal servers.
     Signal's servers present certificates from Signal's own root, which KaiOS doesn't trust, so requests to `*.signal.org` go through the engine's pinned TLS client (`App.signal.net`, over the app's `tcp-socket` permission). Other hosts, and environments without `TCPSocket`, use mozSystem XHR (privileged app: no CORS).

     Authenticated Signal requests carry Basic auth (`<aci>.<deviceId>:<password>`). A 401/403 on the active linked device means this device was unlinked from the primary phone: App.http.onUnlinked fires once so the app returns to the Link Device screen. */

  var unlinkedFired = false;
  var MAX_REDIRECTS = 3;

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

  function netError(message, kind) {
    var err = new Error(message);
    err.kind = kind;
    return err;
  }

  function usesPinnedTls(url) {
    return !!(App.signal && App.signal.net && App.signal.net.isPinnedUrl(url));
  }

  /* Resolves to { status, body: Uint8Array, header(name) } over mozSystem XHR, which follows redirects itself. */
  function xhrSend(method, url, headers, body, timeout) {
    return new Promise(function (resolve, reject) {
      var xhr = makeXhr();
      xhr.open(method, url, true);
      xhr.timeout = timeout;
      xhr.responseType = 'arraybuffer';
      Object.keys(headers).forEach(function (k) {
        xhr.setRequestHeader(k, headers[k]);
      });
      xhr.onload = function () {
        resolve({
          status: xhr.status,
          body: xhr.response ? new Uint8Array(xhr.response) : new Uint8Array(0),
          header: function (name) { return xhr.getResponseHeader(name); }
        });
      };
      xhr.onerror = function () { reject(netError('Network error (check internet connection)', 'network')); };
      xhr.ontimeout = function () { reject(netError('Request timed out', 'timeout')); };
      if (body != null) xhr.send(body);
      else xhr.send();
    });
  }

  /* Same contract over the pinned TLS client. Redirects are followed here; one that leaves Signal's hosts drops the Authorization header and continues over XHR. */
  function pinnedSend(method, url, headers, body, timeout, redirects) {
    return App.signal.net.request({ method: method, url: url, headers: headers, body: body, timeoutMs: timeout }).then(function (res) {
      var location = res.headers.location;
      if (res.status >= 300 && res.status < 400 && res.status !== 304 && location && redirects < MAX_REDIRECTS) {
        var next = new URL(location, url).toString();
        var nextMethod = (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) ? 'GET' : method;
        var nextBody = nextMethod === 'GET' ? null : body;
        if (usesPinnedTls(next)) return pinnedSend(nextMethod, next, headers, nextBody, timeout, redirects + 1);
        var offHost = {};
        Object.keys(headers).forEach(function (k) {
          if (k.toLowerCase() !== 'authorization') offHost[k] = headers[k];
        });
        return xhrSend(nextMethod, next, offHost, nextBody, timeout);
      }
      return {
        status: res.status,
        body: res.body,
        header: function (name) {
          var v = res.headers[String(name).toLowerCase()];
          return v === undefined ? null : v;
        }
      };
    }, function (e) {
      if (e && e.kind === 'timeout') throw netError('Request timed out', 'timeout');
      App.util.dbg('http: pinned TLS ' + method + ' failed: ' + (e && e.message));
      throw netError('Network error (check internet connection)', 'network');
    });
  }

  function send(method, url, headers, body, timeout) {
    if (usesPinnedTls(url)) {
      var bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      return pinnedSend(method, url, headers, bytes || null, timeout, 0);
    }
    return xhrSend(method, url, headers, body, timeout);
  }

  /* opts: { timeout, binary, baseUrl, noAuth, basicAuth: { username, password }, headers: { ... } } */
  function request(method, path, body, opts) {
    opts = opts || {};
    var base = (opts.baseUrl || App.config.serverUrl()).replace(/\/+$/, '');
    if (!base) return Promise.reject(new Error('Signal server address is not configured'));

    var headers = {};
    var isActiveToken = false;
    if (opts.basicAuth && opts.basicAuth.username) {
      headers.Authorization = encodeBasicAuth(opts.basicAuth.username, opts.basicAuth.password || '');
    } else if (!opts.noAuth && App.config.isConfigured()) {
      var login = (App.config.aci() || App.config.number()) + '.' + App.config.deviceId();
      headers.Authorization = encodeBasicAuth(login, App.config.deviceToken());
      isActiveToken = true;
    }
    if (opts.headers) {
      Object.keys(opts.headers).forEach(function (k) {
        headers[k] = opts.headers[k];
      });
    }
    headers['X-Signal-Agent'] = 'OWD';
    var payload = null;
    if (body != null) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    return send(method, base + path, headers, payload, opts.timeout || 15000).then(function (res) {
      if (res.status >= 200 && res.status < 300) {
        if (opts.binary) return new Blob([res.body]);
        var text = res.body.length ? new TextDecoder().decode(res.body) : '';
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch (e) {
          return text;
        }
      }
      var msg = 'HTTP ' + res.status;
      var parsed = null;
      if (res.status === 401) msg += ': this phone is no longer linked to your Signal account';
      try {
        parsed = JSON.parse(new TextDecoder().decode(res.body));
        if (parsed && parsed.error && res.status !== 401) msg += ': ' + parsed.error;
      } catch (e) { /* non-JSON error body */ }
      App.util.dbg('http fail ' + method + ' ' + path + ' -> ' + msg);
      if (res.status === 401 && isActiveToken && !unlinkedFired && App.http.onUnlinked) {
        unlinkedFired = true;
        App.http.onUnlinked();
      }
      var httpErr = new Error(msg);
      httpErr.kind = 'http';
      httpErr.status = res.status;
      httpErr.body = parsed;
      throw httpErr;
    }, function (e) {
      App.util.dbg('http ' + (e.kind || 'error') + ' ' + method + ' ' + path);
      throw e;
    });
  }

  /* Raw binary request (Signal CDN attachments, storage.signal.org protobufs). Resolves to { status, body: Uint8Array, location }; rejects on non-2xx with err.status set. */
  function rawRequest(method, url, bodyBytes, headers, timeout) {
    return send(method, url, headers || {}, bodyBytes || null, timeout || 60000).then(function (res) {
      if (res.status >= 200 && res.status < 300) {
        return { status: res.status, body: res.body, location: res.header('Location') };
      }
      var err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
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
    onUnlinked: null
  };
})();
