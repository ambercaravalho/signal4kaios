# Push bridge — background / closed-app notifications

By default signal4kaios only shows notifications while it is **running** (open or
backgrounded but not killed). Its receive path is a WebSocket, and **no KaiOS
version keeps a WebSocket alive in the background** — when the app is closed, the
socket dies and nothing arrives. A Service Worker can wake for a `push` event
even with the app closed, but signal-cli-rest-api can't send Web Push, and a
Service Worker has neither a WebSocket nor a readable cross-origin `fetch` to the
signal-cli server.

The only way to get notifications while the app is **fully closed** is **Web
Push**, driven by a small always-on **push bridge** you run next to
signal-cli-rest-api. This document specifies the bridge so you can implement or
host it yourself. The **phone side is already built into the app** (Settings →
Background notifications).

> Device support was verified on KaiOS 4.0: `pushManager.subscribe()` returns a
> working endpoint at the KaiOS push service (`notification.kaiostech.com`), and
> the Service Worker can show persistent notifications with up to
> `Notification.maxActions === 2` action buttons.

## Architecture

```
                          ┌───────────────────────────────────────┐
   Signal ───────────────▶│  signal-cli-rest-api  (json-rpc mode)  │
                          └───────────────┬───────────────────────┘
                                          │  receive WebSocket (kept open 24/7)
                                          ▼
                          ┌───────────────────────────────────────┐
                          │            push bridge  (you)          │
                          │  • holds the signal-cli receive socket │
                          │  • stores phone push subscriptions     │
                          │  • sends Web Push per incoming message │
                          └───────────────┬───────────────────────┘
                                          │  Web Push (VAPID) via the
                                          ▼  KaiOS push service
                          ┌───────────────────────────────────────┐
                          │   signal4kaios ServiceWorker (sw.js)   │
                          │   push event → showNotification()      │
                          └───────────────────────────────────────┘
```

The bridge becomes the **always-connected receive client**, which also fixes a
signal-cli limitation: in json-rpc mode, messages that arrive while **no** client
is connected are dropped. With the bridge always connected, nothing is missed.

## What the phone already does

- Subscribes with `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`
  (the VAPID public key from settings, when set).
- `POST`s the subscription to the bridge (`/v1/push/register`).
- Caches the bridge URL/token/number/VAPID key in Cache Storage so the Service
  Worker can reach the bridge while the app is closed.
- On a `push` event, `sw.js`:
  1. If the push has a readable JSON payload, shows it directly.
  2. Otherwise (a keyless "tickle") calls `GET /v1/push/pending` to learn what to
     show.
  3. Always shows at least one notification (required by `userVisibleOnly`).
- Tapping a notification opens the conversation named by `convId`.
- On `pushsubscriptionchange`, re-subscribes and re-registers with the bridge.

## HTTP API the bridge must expose

All requests are JSON. If a bridge token is configured on the phone it is sent as
`Authorization: Bearer <token>` — validate it and reject others with `401`.

**CORS:** the phone registers over a privileged (mozSystem) XHR that bypasses
CORS, but the Service Worker's fallback `GET /v1/push/pending` is an ordinary
cross-origin `fetch`. The bridge **must** send CORS headers on `/v1/push/pending`
(and ideally all endpoints):

```
Access-Control-Allow-Origin: *            (or the app origin)
Access-Control-Allow-Headers: authorization, content-type
```

### `POST /v1/push/register`

Register (or refresh) a device subscription.

Request body:

```json
{
  "number": "+15551234567",
  "platform": "kaios",
  "subscription": {
    "endpoint": "https://notification.kaiostech.com:8443/....",
    "expirationTime": null,
    "keys": { "p256dh": "<base64url>", "auth": "<base64url>" }
  }
}
```

Behavior: upsert keyed by `subscription.endpoint`; associate it with `number`.
Respond `200` (body ignored).

### `POST /v1/push/unregister`

```json
{ "number": "+15551234567", "endpoint": "https://notification.kaiostech.com:8443/...." }
```

Remove the subscription. Respond `200`.

### `GET /v1/push/pending?number=<n>&endpoint=<e>`

Fallback used only when a push arrived without a readable payload. Return the
notifications to display now (and mark them delivered so they aren't shown twice):

```json
{ "messages": [
  { "title": "Alice", "body": "See you at 6", "convId": "+15559876543", "count": 1 }
] }
```

An empty list is valid (the worker then shows a generic "New message").

## Push message payload (bridge → phone)

When the push service supports payloads, encrypt this JSON (aes128gcm, per RFC
8291, using the subscription's `p256dh`/`auth` — any `web-push` library does
this) so `sw.js` can show it without a round-trip:

```json
{
  "title": "Alice",            // conversation / sender name
  "body": "See you at 6",      // preview text (avoid full PII if you can)
  "convId": "+15559876543",    // recipient number or group id; opens this chat
  "count": 1                   // optional unread hint
}
```

`convId` must match the app's conversation id: the **sender's number** for a
direct chat, or the **group id** for a group. If you can't (or don't want to)
send a payload, send an empty/tickle push and implement `/v1/push/pending`.

## VAPID keys

Generate one key pair for the bridge (e.g. `npx web-push generate-vapid-keys`):

- **Public key** → enter in the app under Settings → Background notifications →
  *VAPID public key*. The phone subscribes with it so only your bridge can push.
- **Private key** → keep on the bridge; used to sign each push.

Leaving the VAPID key blank still works on KaiOS (subscription succeeds), but
then **anyone who learns the endpoint can push to the device** — set it in any
real deployment.

## Reference send loop (pseudocode)

```
sock = websocket("ws://127.0.0.1:8080/v1/receive/" + NUMBER)   # keep reconnecting
on message(frame):
    ev = parse(frame)                       # dataMessage / reaction / etc.
    if not ev.isIncomingMessage: continue
    note = { title: nameFor(ev.source),
             body: preview(ev),
             convId: ev.groupId or ev.source,
             count: 1 }
    for sub in subscriptionsFor(NUMBER):
        try: webpush.send(sub, encrypt(note), vapid=VAPID)   # aes128gcm
        except GONE(404/410): remove(sub)                    # stale subscription
```

Envelope shapes vary across signal-cli versions; mirror the parsing approach in
[`app/js/normalize.js`](../app/js/normalize.js) and skip frames you don't
recognize rather than crashing.

## Security notes

- **Transport:** run the bridge over HTTPS/WSS. Push subscription endpoints and
  their keys are sensitive; never log them.
- **Auth:** protect `/v1/push/*` with the bearer token; without it, anyone can
  register endpoints or read pending messages.
- **Data minimization:** notification `body` text leaves your infrastructure via
  the push service. Prefer short previews, or send tickle-only pushes plus
  `/v1/push/pending` (kept inside your network) if the preview text is sensitive.
- **VAPID:** always set a VAPID key pair in production so only your bridge can
  push to a subscription.
- The bridge sees **all** incoming message content (it is the receive client).
  Treat it with the same trust as signal-cli-rest-api itself.

## Turning it on (phone)

Settings → **Background notifications**:

1. **Push bridge URL** — where your bridge is reachable (e.g.
   `https://push.example.com`).
2. **VAPID public key** — from the bridge (recommended).
3. **Bridge token** — optional bearer token if your bridge requires one.
4. **Enable** — subscribes and registers. The status line shows the push service
   host on success.

Without a running bridge these settings do nothing; the app keeps notifying only
while it is open.
