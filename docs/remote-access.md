# Remote access (connection auth modes)

To use the app away from home, put the **[gateway](gateway.md)** behind a reverse
proxy with a public `https://` address and authenticate the connection. The
gateway adds no auth of its own, so the reverse proxy in front of it is where
authentication lives. The app has **three connection auth modes**, chosen in
**Settings -> Server & connection -> Connection security**; each authenticates
every request the app makes — the HTTP API *and* the receive WebSocket.

- [Choosing a mode](#choosing-a-mode)
- [Why the WebSocket is the hard part](#why-the-websocket-is-the-hard-part)
- [Receive token mode](#receive-token-mode)
- [Pangolin](#pangolin)
- [Risks and hardening](#risks-and-hardening)
- [How to tell it's happening](#how-to-tell-its-happening)

## Choosing a mode

| Mode | What it does | Pros | Cons |
|---|---|---|---|
| **Unauthenticated** | No credentials on any request | Nothing to configure | Anyone who can reach the server can read your messages and send as you |
| **Basic header auth only** | `Authorization: Basic` on the HTTP API; WebSocket sent with no auth | Password-protects the HTTP API | A browser can't send Basic Auth on a WebSocket, so the live receive path is left unauthenticated |
| **Receive token** | One token sent as `?<param>=<token>` on **every** request, including the WebSocket | One secret covers both the API and live updates; works with any proxy that validates a query token | The token is a bearer secret (treat like a password) and appears in proxy logs |

**Unauthenticated** is only safe on a trusted home LAN or a private VPN/tunnel,
and even then it's risky. **Basic header auth only** is a half-measure: your API
is protected but the receive path isn't, so either lock `/v1/receive` down
separately or expect live updates to be blocked. **Receive token** is the
recommended mode for any internet-facing setup.

## Why the WebSocket is the hard part

Messages arrive over a `wss://` WebSocket to `/v1/receive/<number>`, and a
browser's `WebSocket` API refuses both custom handshake headers (no
`Authorization`) and URL userinfo (`wss://user:pass@host/...` doesn't work).
There is no API to attach credentials to the handshake. That's why Basic Auth
can only ever cover the HTTP API, and why the token mode exists: the one thing a
browser lets you put on the handshake is the URL's **query string**.

## Receive token mode

The app sends the token as a query param on every request:

- HTTP: `https://<host>/v1/...?<param>=<token>` (see
  [`http.js`](../app/js/http.js)).
- WebSocket: `wss://<host>/v1/receive/<number>?<param>=<token>` (see
  [`ws.js`](../app/js/ws.js)); the token is redacted from the debug log.

Set it up in **Settings -> Server & connection**:

1. Choose **Connection security -> Receive token**.
2. Paste the token into **Receive token**.
3. Set **Token query param** to whatever your proxy expects (default `token`).
4. Save.

Your reverse proxy must be configured to accept requests that carry a valid
token in that query param and reject the rest. Any proxy that can validate a
query-string secret works (a Traefik/Caddy/nginx rule, an auth middleware, an
edge function, etc.). Use `wss://`/`https://` so the token is encrypted in
transit.

The gateway's push endpoints ride the same token: the app registers over
`App.http` (which appends the param), and the ServiceWorker appends it to its own
`/v1/push/*` fetches while the app is closed — so a single token requirement in
front of the gateway covers the API, the receive WebSocket, and background push.

## Pangolin

[Pangolin](https://github.com/fosrl/pangolin) validates a **Resource Access
Token** passed in a query param (its default is `p_token`), on every request
including the WebSocket upgrade.

1. In Pangolin, open the resource -> **Access Tokens** (Shareable Links) ->
   create a non-expiring token. You get a value shaped `<token-id>.<secret>`.
2. In the app: **Connection security -> Receive token**, paste that whole value,
   and set **Token query param** to `p_token`.

> **Not a PATH rule.** A rule like `PATH = /v1/receive/*token=SECRET*` cannot
> work: Pangolin matches the path with the query **stripped off**, so the
> `?token=...` isn't in the string. The access-token feature is the only thing
> that reads the query.

Notes:

- The value **must** be the `<id>.<secret>` token Pangolin generates - it splits
  on the `.` and looks the ID up, so an arbitrary passphrase is rejected.
- The token authenticates the **whole resource** - treat it as sensitive as a
  password.

## Risks and hardening

The receive path streams your incoming (and synced sent) messages in real time.
Watch for:

- **A resource with no auth at all is fully open** - every request is allowed
  and the token is never checked. Keep the token requirement on it.
- **Too-broad an exemption is catastrophic.** If you instead exempt a path
  rather than use a token, scope it to exactly `/v1/receive` (ideally
  `/v1/receive/<your-number>`). Exempting `/v1/*` or the whole host exposes
  `send`, account, and username endpoints (proxied through the gateway) - an
  attacker could impersonate you, link a device, or unregister the number.
- **`ws://` / `http://` (no TLS) leaks the token in cleartext.** Always use
  `wss://` / `https://`.
- **The token appears in proxy logs** unless disabled. Keep it long, and rotate
  on leak.
- **Prefer defense-in-depth** - a tunnel/VPN (Newt / WireGuard / Tailscale)
  keeps the server off the public internet, making the token a second layer
  rather than the only wall.

## Alternative: exempt the receive path

If you'd rather not use a token, give the WebSocket path its own resource/rule
with auth **off**, scoped to `/v1/receive`, and protect it another way (an IP
allowlist, or a tunnel / private network it already sits behind). Everything
else under the hostname keeps its auth. Use **Basic header auth only** mode in
the app for the HTTP API in that case.

## How to tell it's happening

If messages stop arriving, check **Settings -> Debug log**. A socket that
**closes immediately after connecting** while an auth mode is set is the
telltale: in token mode the proxy is rejecting the token (wrong value or wrong
param name); in Basic Auth mode the proxy is blocking the unauthenticated
WebSocket. The app detects the pattern (a handshake rejected within a few seconds
before the socket opens - see [`ws.js`](../app/js/ws.js)), logs an explanatory
line, and shows a one-time toast: *"Live updates blocked by the proxy auth - see
Debug log."*

Note: the query-string handshake still depends on how KaiOS's `WebSocket`
behaves on-device (Gecko 48 on 2.5, Gecko 84/123 on 3.0/3.1/4.0), so verify live
updates on the phone - desktop doesn't exercise the same code path.
