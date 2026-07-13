# Remote access (reverse proxy + HTTP Basic Auth)

To use the app away from home, put the signal-cli-rest-api server behind a
reverse proxy with a public `https://` address, protected by **HTTP Basic Auth**
(for example [Pangolin](https://github.com/fosrl/pangolin)'s "header auth", built
on Traefik).

- [Configuring the app](#configuring-the-app)
- [The WebSocket caveat](#the-websocket-caveat)
- [Authenticating the receive path with a token](#authenticating-the-receive-path-with-a-token)
- [Alternative: exempt the receive path](#alternative-exempt-the-receive-path)
- [Risks if this isn't set up perfectly](#risks-if-this-isnt-set-up-perfectly)
- [How to tell it's happening](#how-to-tell-its-happening)

## Configuring the app

**Settings → Server & connection** has **Reverse proxy username** and
**password** — standard HTTP Basic Auth credentials, the same ones you'd put in
`https://user:pass@resource.example.com`. Point **Server URL** at the public
`https://` address, fill them in, and Save.

On every HTTP request [`http.js`](../app/js/http.js) attaches an explicit
`Authorization: Basic …` header, so contacts, groups, sending, receipts,
reactions, and media all work behind Basic Auth.

## The WebSocket caveat

**Basic Auth covers only the HTTP API. The live WebSocket cannot be
authenticated that way in any browser, and there's no client-side fix.**

Messages arrive over a `wss://` WebSocket to `/v1/receive/<number>`, and a
browser's `WebSocket` API refuses both custom handshake headers (no
`Authorization`) and URL userinfo (`wss://user:pass@host/…` doesn't work). There
is no API to attach credentials to the handshake, and Basic Auth middlewares are
stateless — they check the WebSocket upgrade request too, and reject it. So the
socket fails on every attempt while everything else works. **The fix belongs on
the proxy, not the app.**

## Authenticating the receive path with a token

The one thing a browser lets you put on the handshake is the URL's **query
string**, so the app can carry a secret there for the proxy to validate.

With Pangolin the right mechanism is a **Resource Access Token**, passed as
`?p_token=<token-id>.<access-token>` and validated on every request, including
the WebSocket upgrade (see
[Shareable Links](https://docs.pangolin.net/manage/access-control/links)).

> **Not a PATH rule.** A rule like `PATH = /v1/receive/*token=SECRET*` cannot
> work: the Badger plugin hands Pangolin the path with the query **stripped
> off**, so the rule is matched against `/v1/receive/+15551234567` — the
> `?token=…` isn't in the string, nothing matches, and the request falls through
> to your block rule. Pangolin's rule engine has no query matcher; the
> access-token feature is the only thing that reads the query.

Setup:

1. In Pangolin, open the resource → **Access Tokens** (Shareable Links) → create
   a non-expiring token. You get a value shaped `<token-id>.<access-token>`.
2. In the app: **Settings → Server & connection → Receive token**, paste that
   whole value, and Save.
3. Leave your Basic Auth / header auth on the resource as-is for the HTTP API.

The app then connects to
`wss://<host>/v1/receive/<number>?p_token=<token-id>.<access-token>` (redacted in
the debug log). Pangolin verifies the `p_token` and allows the handshake, while
everything else keeps using Basic Auth.

Notes:

- The value **must** be the `<id>.<secret>` token Pangolin generates — it splits
  on the `.` and looks the ID up in its database, so an arbitrary passphrase is
  rejected.
- `p_token` is Pangolin's default query param
  (`server.resource_access_token_param`). If your deployment changed it, adjust
  the param the app sends to match.
- The token authenticates the **whole resource** — treat it as sensitive as your
  Basic Auth password.
- Use `wss://` so the token is encrypted in transit; it's then visible only in
  the proxy's own logs (disable logging for that route, and rotate on leak).

## Alternative: exempt the receive path

If you'd rather not use a token, give the WebSocket path its own resource/rule
with Basic Auth **off**:

- Create a **second resource** for the same backend scoped to **`/v1/receive`**
  (or a separate subdomain routed to it), with Basic Auth off.
- Since that leaves it unauthenticated at the proxy, protect it another way — an
  **IP allowlist**, or a tunnel / private network it already sits behind.
- Everything else under the hostname keeps Basic Auth.

## Risks if this isn't set up perfectly

The receive path streams your incoming (and synced sent) messages in real time.
Watch for:

- **A PATH rule can't gate on the token** — it matches the query-stripped path,
  so use the `p_token` access token instead.
- **A resource with no auth at all is fully open** — if the resource has no
  Pangolin auth method enabled, every request is allowed and the token is never
  checked. Keep at least one auth method on it.
- **Too-broad an exemption is catastrophic.** Scope any bypass to exactly
  `/v1/receive` (ideally `/v1/receive/<your-number>`). Exempting `/v1/*` or the
  whole host exposes `send`, account, and username endpoints — an attacker could
  impersonate you, link a device, or unregister the number.
- **`ws://` (no TLS) leaks the token in cleartext.** Always use `wss://`.
- **The token is a bearer secret**, equivalent to read access to your messages,
  and appears in proxy logs unless disabled. Keep it long, and rotate on leak.
- **Keep `/v1/attachments` authenticated** — bodies arrive over the receive
  stream, but media is a separate fetch, so a token-only eavesdropper sees text
  but can't pull media.
- **Prefer defense-in-depth** — a tunnel/VPN (Newt / WireGuard / Tailscale)
  keeps the receive path off the public internet, making the token a second layer
  rather than the only wall.

Note: the `?p_token=` handshake still depends on how KaiOS's Gecko 48 `WebSocket`
behaves on-device, so verify live updates on the phone — desktop doesn't exercise
the same code path.

## How to tell it's happening

If messages stop arriving after you configure proxy auth, check **Settings →
Debug log**. A socket that **closes immediately after connecting**, right when
Basic Auth is configured, is this issue. The app detects the pattern (a handshake
rejected within a few seconds, before the socket opens — see
[`ws.js`](../app/js/ws.js)), logs an explanatory line, and shows a one-time
toast: *"Live updates blocked by the proxy auth — see Debug log."*
