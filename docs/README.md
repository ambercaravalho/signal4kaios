# signal4kaios documentation

A Signal client for **KaiOS 2.5, 3.0, 3.1, and 4.0** feature phones, backed by a
self-hosted
[signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) server
fronted by the signal4kaios **gateway**. Start with whichever section fits what
you're doing.

## For users

- **[Getting started](getting-started.md)** — set up the server, sideload the
  app, and configure it on first run.
- **[User guide](user-guide.md)** — every feature, the keypad reference, and
  [troubleshooting](user-guide.md#troubleshooting).
- **[Remote access](remote-access.md)** — a reverse proxy with Basic Auth, and
  the one WebSocket caveat to know about.
- **[Gateway](gateway.md)** — the Node/TS backend the app talks to: HTTP proxy,
  buffered WebSocket relay with backlog replay, and always-on background push.

## For developers

- **[Architecture](architecture.md)** — receive/send flow, module reference,
  IndexedDB schema, and normalized event shapes.
- **[Development](development.md)** — Gecko 48 constraints, cross-version support
  (2.5 / 3.0 / 3.1 / 4.0), packaging, desktop dev, conventions, and adding a
  screen.
- **[Store listing](store-listing.md)** — releases, the OStore source, and
  catalogue-maintainer handoff.
- **[AGENTS.md](../AGENTS.md)** — condensed rules for AI agents (and a fast
  orientation for humans).

## How the pieces fit together

```
                    your home network / a reverse proxy
                                  │
 ┌───────────────┐  HTTP + WS     │   ┌──────────────┐      ┌────────────────────┐
 │  signal4kaios │◀──────────────▶│──▶│   gateway    │─────▶│ signal-cli-rest-api │──▶ Signal
 │  (KaiOS app)  │                │   │  (Node/TS)   │      │   (json-rpc mode)   │
 └───────────────┘                │   └──────────────┘      └────────────────────┘
                                  │      (buffer + push)         (internal only)
```

The app is only a client, and it talks to a single backend: the
**[gateway](gateway.md)**, which proxies HTTP to signal-cli-rest-api, relays the
receive WebSocket with a buffered backlog, and sends background push. Your Signal
account lives on signal-cli-rest-api, which must be **registered or linked** and
running in **`json-rpc`** mode; it stays internal and is never exposed to the app.
The phone reaches the gateway over Wi-Fi or through a reverse proxy (see
[Remote access](remote-access.md)).
