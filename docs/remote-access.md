# Remote access (reverse proxy + HTTP Basic Auth)

To use the app away from home you'll typically put the signal-cli-rest-api
server behind a reverse proxy with a public `https://` address, protected by
**HTTP Basic Auth** (for example
[Pangolin](https://github.com/fosrl/pangolin)'s "header auth", which is built on
Traefik).

- [Configuring the app](#configuring-the-app)
- [The WebSocket caveat (important)](#the-websocket-caveat-important)
- [The fix: exempt the receive path](#the-fix-exempt-the-receive-path)
- [How to tell this is happening](#how-to-tell-this-is-happening)

## Configuring the app

Settings has two optional fields, **Reverse proxy username** and **Reverse proxy
password**. These are standard HTTP Basic Auth credentials — the same ones you'd
put in `https://username:password@resource.example.com`.

1. Point **Server URL** at the public `https://` address.
2. Fill in the username and password.
3. Press **Save**.

On every HTTP request, [`http.js`](../app/js/http.js) attaches an explicit
`Authorization: Basic …` header, so contacts, groups, sending, receipts,
reactions, and media all work fine behind Basic Auth.

## The WebSocket caveat (important)

**Basic Auth only covers the HTTP API. The live WebSocket connection cannot be
authenticated this way, in any browser, and there is no client-side fix.**

Why: the app receives messages over a `ws://` / `wss://` WebSocket to
`/v1/receive/<number>`. A browser's `WebSocket` API refuses **both**:

- custom handshake headers (so the app can't send `Authorization`), and
- userinfo in the URL (so `wss://user:pass@host/…` doesn't work either).

There is simply no JavaScript API to attach credentials to the WebSocket
handshake. An earlier version of this app tried priming Gecko's HTTP auth cache
with a prior authenticated XHR, hoping the browser would carry the credentials
over to the handshake. Testing against a Traefik-based proxy (Pangolin's "header
auth") proved it does not: Basic Auth middlewares are **stateless** and check
every single request independently, including the WebSocket **upgrade** request.
So the socket gets rejected on every attempt while everything else works —
exactly as if only half the app were behind the proxy.

**The fix has to happen on the proxy, not in the app.**

## The fix: exempt the receive path

Give the WebSocket path its own resource/rule that does **not** require Basic
Auth:

- In Pangolin, create a **second resource** for the same backend, scoped to the
  **`/v1/receive`** path (or a separate subdomain routed to it), and leave Basic
  Auth **off** that one.
- If that path still needs protection, use something that doesn't depend on a
  per-request header — an **IP allowlist**, or simply relying on it already
  sitting behind your tunnel / private network.
- The rest of the resource (everything else under the same hostname) can keep
  Basic Auth as normal — only the receive path needs the exemption.

## How to tell this is happening

If messages stop arriving after you configure proxy auth, check
**Settings → Debug log**. A socket that **closes immediately after connecting**,
right when Basic Auth is configured, is this exact issue.

The app detects that pattern — a handshake rejected before the socket ever opens,
within a few seconds, with Basic Auth configured (see
[`ws.js`](../app/js/ws.js)) — logs an explanatory line to the debug log, and
shows a one-time toast: *"Live updates blocked by the proxy auth — see Debug
log."*
