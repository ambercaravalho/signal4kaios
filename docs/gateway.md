# Gateway — the app's backend

signal4kaios talks to a single backend: the **gateway**, a small Node/TypeScript
service that sits directly in front of
[signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api). The app
never reaches signal-cli-rest-api directly. The gateway:

- **reverse-proxies** every HTTP API call to signal-cli-rest-api,
- **relays the receive WebSocket** and **buffers** it, so a reconnecting app can
  replay everything it missed via a cursor (no more dropped messages while
  offline), and
- **sends Web Push** so the app is notified of new messages even when it is fully
  **closed** (KaiOS 3.0+).

The gateway lives in [`gateway/`](../gateway). Because it runs server-side on
modern Node, the Gecko-48 syntax constraints that apply to the phone app do
**not** apply to it.

## Why a gateway (and why closed-app push needs one)

The app's receive path is a WebSocket, and **no KaiOS version keeps a WebSocket
alive in the background** — when the app is closed, the socket dies. Worse, in
`json-rpc` mode signal-cli-rest-api **drops** messages that arrive while no
client is connected. A ServiceWorker can wake for a `push` event with the app
closed, but it has neither a WebSocket nor a readable cross-origin `fetch` to
signal-cli.

The gateway solves all of this at once by being the **always-connected receive
client**: it holds the signal-cli socket open 24/7 (so nothing is dropped),
buffers frames (so the app can replay its backlog), and turns incoming messages
into Web Push (so the app is notified while closed).

> Device support was verified on KaiOS 4.0: `pushManager.subscribe()` returns a
> working endpoint at the KaiOS push service (`notification.kaiostech.com`), and
> the ServiceWorker can show notifications while the app is closed.

## Architecture

```
                          ┌───────────────────────────────────────┐
   Signal ───────────────▶│  signal-cli-rest-api  (json-rpc mode)  │
                          └───────────────┬───────────────────────┘
                                          │  upstream receive WS (24/7) + HTTP
                                          ▼
                          ┌───────────────────────────────────────┐
                          │              gateway (Node/TS)         │
                          │  • reverse-proxies all HTTP            │
                          │  • buffers receive frames (per number) │
                          │  • relays WS with backlog replay       │
                          │  • sends Web Push when the app is idle  │
                          └───────────────┬───────────────────────┘
              HTTP proxy + relay WS       │        Web Push (app closed)
                                          ▼
                          ┌───────────────────────────────────────┐
                          │           signal4kaios (KaiOS)         │
                          │   live: WS frames → store              │
                          │   closed: ServiceWorker push event     │
                          └───────────────────────────────────────┘
```

signal-cli-rest-api sits on an internal-only network; only the gateway is
exposed to the app.

## Configuration (environment)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8090` | Port the gateway listens on (the app's Server URL points here). |
| `SIGNAL_CLI_URL` | `http://127.0.0.1:8080` | signal-cli-rest-api base URL (internal). |
| `DB_PATH` | `./data/gateway.db` | SQLite file for buffer/subscriptions/cursors. |
| `RETENTION_PER_NUMBER` | `500` | Frames buffered per number (backlog cap; mirrors the app's ~500/conv prune). |
| `PUSH_WHEN_IDLE_ONLY` | `true` | Only push when no app socket is connected for that number (the open app notifies itself). |
| `VAPID_PUBLIC` / `VAPID_PRIVATE` | empty | Optional VAPID keypair (`npx web-push generate-vapid-keys`). |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | VAPID contact. |

## Receive WebSocket protocol (gateway ↔ app)

The app connects to `GET /v1/receive/<number>?since=<seq>` (WebSocket upgrade),
where `since` is the highest per-number sequence number the app has already
applied (persisted in IndexedDB, key `wsCursor`). The gateway then:

1. replays each buffered frame with `seq > since` as a **`backlog`** envelope,
2. sends a **`backlog-done`** sentinel carrying the newest `seq`, then
3. streams new frames live as **`frame`** envelopes.

Envelope shape:

```json
{ "t": "backlog" | "backlog-done" | "frame", "seq": 42, "data": { /* raw signal-cli frame */ } }
```

- `data` is the **raw signal-cli frame**, parsed by the same
  [`normalize.js`](../app/js/normalize.js) as before.
- On `backlog`, the app ingests **silently** (updates history + unread counts but
  shows no notification, since those messages were already pushed while closed).
- On `frame` (live) it ingests normally and notifies.
- The app advances and persists its cursor from each envelope's `seq`, so the
  next reconnect resumes with `?since=<seq>` — no gaps, no duplicates.

If the app is pointed straight at signal-cli-rest-api (no gateway), a message
without a `t` field is treated as a raw frame, so basic receive still works
(without backlog or push).

## HTTP surface

| Route | Handled by | Notes |
| --- | --- | --- |
| `GET /healthz` | gateway | Liveness check. |
| `GET /v1/push/vapid` | gateway | `{ "publicKey": "<vapid or empty>" }`; the app reads this to subscribe. |
| `POST /v1/push/register` | gateway | `{ number, subscription }` — store a push subscription. |
| `POST /v1/push/unregister` | gateway | `{ endpoint }` — drop a subscription. |
| `POST /v1/push/test` | gateway | `{ number }` — send a canned notification to every subscription for that number (ignores the idle gate) and return each push service's status. Handy for debugging. |
| everything else | proxy | Forwarded verbatim (method, path, query, headers, body, binary) to `SIGNAL_CLI_URL`. |

signal-cli has no `/v1/push/*` routes, so there is no collision.

## Push (always on, zero configuration in the app)

Background push is **always enabled** in the app — there are no push settings.
On boot the app:

1. fetches the gateway's VAPID public key from `GET /v1/push/vapid`,
2. subscribes with `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`
   (keyless if the gateway has no VAPID configured), and
3. registers the subscription with `POST /v1/push/register` over `App.http` (so it
   inherits the app's connection auth mode).

It also caches the gateway URL, number, VAPID key, and — in token auth mode — the
receive token/param in Cache Storage, so the ServiceWorker
([`sw.js`](../app/sw.js)) can re-register a rotated push subscription while the
app is closed.

For the OS to cold-wake the (stopped) ServiceWorker on a push, the app must both
declare the `push` system message in the manifest **and** subscribe at runtime.
On KaiOS 3.0+ the app calls `registration.systemMessageManager.subscribe('push')`
(see [`push.js`](../app/js/push.js)); on 2.5 the `serviceworker`/`push` manifest
permissions wire it up. Missing that runtime subscribe is the usual reason a push
returns `201` at the server but no notification ever appears.

On an incoming message, the gateway builds a note by mirroring the conversation
id rules in [`normalize.js`](../app/js/normalize.js) (group → `g:<id>`, otherwise
the sender's number/uuid) so tapping the notification opens the right chat. When
`PUSH_WHEN_IDLE_ONLY` is true and the app is currently connected for that number,
the push is skipped (the app shows its own notification).

### KaiOS push service quirks

The KaiOS push service (`notification.kaiostech.com`) is a fork of Mozilla's old
autopush and is stricter than modern browsers, so the gateway adapts:

- **Encoding.** It only accepts the legacy `aesgcm` content encoding, not
  web-push's default `aes128gcm`. The gateway always sends `aesgcm`.
- **Payloads need VAPID.** KaiOS only delivers a push *payload* (the message
  text) when it is VAPID-signed. So with VAPID the gateway sends the note as an
  encrypted `aesgcm` payload and the ServiceWorker shows it directly; without
  VAPID it can only send an empty push, which shows a generic "New message".
  Configure VAPID to get real message text.
- **App must subscribe for wake.** See the note above — the `push` permission
  plus a runtime `systemMessageManager.subscribe('push')` (3.0+) are required for
  the OS to cold-wake the worker.

If pushes never arrive, check the gateway log for `push: sent … (201)` vs.
`push: send failed … (4xx)`, or trigger `POST /v1/push/test` with your number to
see the push service's response directly. A `201` with no notification almost
always means the runtime subscribe is missing or notifications aren't permitted.

## Deploying

Use the Compose setup in [`docker/`](../docker), which keeps signal-cli-rest-api
on an internal-only network and publishes only the gateway:

```sh
cp docker/.env.example docker/.env
docker compose -f docker/docker-compose.yml up -d
```

Then set the app's **Server URL** to the gateway. To run the gateway outside
Docker, see
[Development → Developing the gateway](development.md#developing-the-gateway).

## Authentication

The gateway adds **no** authentication of its own (a single middleware seam is
left in the proxy/WS layer for adding it later). Protect it by putting a reverse
proxy in front and using the app's built-in connection auth modes
(none / basic / receive token) — see [Remote access](remote-access.md). Those
modes now authenticate the app against the reverse proxy **in front of the
gateway**; they are independent of the gateway itself.

## Security notes

- **Transport:** run the gateway behind HTTPS/WSS for remote access. Push
  subscription endpoints and their keys are sensitive; the gateway never logs
  them (numbers are masked in logs).
- **Data minimization:** notification `body` text leaves your infrastructure via
  the push service. Set `PUSH_WHEN_IDLE_ONLY=true` (default) and keep previews
  short; the buffer, subscriptions, and pending queue otherwise stay inside your
  network.
- **VAPID:** set a VAPID key pair in production so only your gateway can push to a
  subscription; without it, anyone who learns the endpoint could.
- The gateway sees **all** incoming message content (it is the receive client).
  Treat it with the same trust as signal-cli-rest-api itself.
