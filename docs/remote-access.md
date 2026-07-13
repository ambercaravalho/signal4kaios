# Remote access (reverse proxy + HTTP Basic Auth)

To use the app away from home you'll typically put the signal-cli-rest-api
server behind a reverse proxy with a public `https://` address, protected by
**HTTP Basic Auth** (for example
[Pangolin](https://github.com/fosrl/pangolin)'s "header auth", which is built on
Traefik).

- [Configuring the app](#configuring-the-app)
- [The WebSocket caveat (important)](#the-websocket-caveat-important)
- [Authenticating the receive path with a token (recommended)](#authenticating-the-receive-path-with-a-token-recommended)
- [Alternative: exempt the receive path](#alternative-exempt-the-receive-path)
- [Risks if this is not set up perfectly](#risks-if-this-is-not-set-up-perfectly)
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

## Authenticating the receive path with a token (recommended)

The one thing a browser lets you put on the WebSocket handshake is the URL's
**query string**. So the app can carry a secret there, and the proxy can
validate it — giving the receive path real authentication without an
`Authorization` header.

With Pangolin the right mechanism is a **Resource Access Token**, *not* a PATH
rule. Pangolin natively accepts an access token in the query string as
`?p_token=<token-id>.<access-token>` and validates it on every request,
including the WebSocket upgrade. (See
[Shareable Links](https://docs.pangolin.net/manage/access-control/links).)

> **Why not a PATH rule?** It is tempting to add a rule like
> `PATH = /v1/receive/*token=SECRET*`. It cannot work. The Badger plugin sends
> Pangolin the request path with the query string **stripped off** (it goes in a
> separate field), and the rule engine matches only against that path. So the
> rule is tested against `/v1/receive/+15551234567` — the `?token=…` is never in
> the string, no glob can match it, and the request falls through to whatever
> comes next (typically your block rule → `401`). Pangolin has no query matcher
> in its rule engine; the access-token feature above is the only thing that
> reads the query.

Setup:

1. In Pangolin, open the resource for your signal-cli-rest-api server →
   **Access Tokens** (a.k.a. Shareable Links) → create a token. Set it to **not
   expire**. Pangolin gives you a value of the form `<token-id>.<access-token>`
   (two parts joined with a dot).
2. In the app: **Settings → Server & connection → Receive token**, and paste
   that whole `<token-id>.<access-token>` value. Press **Save**.
3. Leave your existing Basic Auth / header auth on the resource as-is for the
   HTTP API.

When set, the app connects to
`wss://<host>/v1/receive/<number>?p_token=<token-id>.<access-token>` (the token
is redacted in the debug log). Pangolin sees the `p_token` query param, verifies
it against the resource, and allows the handshake — while `send`, `contacts`,
`attachments`, etc. keep working through Basic Auth and the app's
`Authorization: Basic` header.

Notes:

- The value **must** be the `<id>.<secret>` token Pangolin generates. An
  arbitrary passphrase won't work: Pangolin splits on the `.`, looks the ID up
  in its database, and rejects anything it doesn't recognize.
- `p_token` is Pangolin's default query-param name
  (`server.resource_access_token_param` in `config.yml`). If your deployment
  changed it, either change it back or adjust the param the app sends.
- The access token authenticates the **whole resource**, so anyone who has it
  can reach the full API — treat it as sensitive as your Basic Auth password.
- Serve over `wss://` (TLS) so the query — and thus the token — is encrypted in
  transit; it is then only visible to the proxy's own logs. Disable access
  logging for that route (or accept it) and rotate the token if it leaks.

## Alternative: exempt the receive path

If you can't or don't want to use a token, give the WebSocket path its own
resource/rule that does **not** require Basic Auth:

- In Pangolin, create a **second resource** for the same backend, scoped to the
  **`/v1/receive`** path (or a separate subdomain routed to it), and leave Basic
  Auth **off** that one.
- Because that leaves the path unauthenticated at the proxy, it **must** be
  protected another way — an **IP allowlist**, or simply relying on it already
  sitting behind your tunnel / private network.
- The rest of the resource (everything else under the same hostname) can keep
  Basic Auth as normal — only the receive path needs the exemption.

## Risks if this is not set up perfectly

The receive path streams your **incoming messages** (and your own synced sent
messages) in real time. Getting the proxy config wrong can leave that readable,
or worse. Watch for:

- **A PATH rule cannot gate on the token.** As explained above, Pangolin
  matches PATH rules against the query-stripped path, so a rule like
  `/v1/receive/*token=SECRET*` never matches and the socket is denied. Use the
  Resource Access Token (`p_token`) approach instead — it's the only path that
  reads the query.
- **A resource with no auth at all is fully open.** If the resource has *no*
  Pangolin auth method enabled (no Basic/header auth, SSO, password, or PIN),
  Pangolin allows every request and the token is never checked. Keep at least
  one auth method on the resource so the receive path actually requires the
  token.
- **Exempting too broad a path is catastrophic.** Scope any exemption/bypass to
  exactly `/v1/receive` (ideally `/v1/receive/<your-number>`). A broad rule like
  `/v1/*` or exempting the whole host exposes `send`, account, and username
  endpoints — an attacker could impersonate you, link a device, or unregister
  the number, not merely read messages.
- **`ws://` (no TLS) leaks the token in cleartext.** Anyone on the network path
  can capture it and then read your messages. Always use `wss://`.
- **The token is a bearer secret.** It is equivalent to read access to your
  incoming messages. It appears in proxy access logs unless you disable logging
  for that route; keep it long and random, and rotate it if exposed.
- **Keep `/v1/attachments` authenticated.** Message *bodies* arrive over the
  receive stream, but media is a separate fetch. If attachments stay behind auth,
  a token-only eavesdropper sees text but cannot pull photos/video/voice notes.
- **Prefer defense-in-depth.** Keeping the whole server behind your tunnel/VPN
  (Newt / WireGuard / Tailscale) means the receive path isn't reachable from the
  public internet at all, and the token becomes a second layer rather than the
  only wall.

Note: the `?p_token=` handshake still depends on how KaiOS's Gecko 48
`WebSocket` behaves on the actual device, so verify live updates on the phone
after configuring it — a desktop browser does not exercise the same code path.

## How to tell this is happening

If messages stop arriving after you configure proxy auth, check
**Settings → Debug log**. A socket that **closes immediately after connecting**,
right when Basic Auth is configured, is this exact issue.

The app detects that pattern — a handshake rejected before the socket ever opens,
within a few seconds, with Basic Auth configured (see
[`ws.js`](../app/js/ws.js)) — logs an explanatory line to the debug log, and
shows a one-time toast: *"Live updates blocked by the proxy auth — see Debug
log."*
