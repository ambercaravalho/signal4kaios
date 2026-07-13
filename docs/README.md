# signal4kaios documentation

A Signal client for **KaiOS 2.5** feature phones, backed by a self-hosted
[signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) server.
Start with whichever section fits what you're doing.

## For users

- **[Getting started](getting-started.md)** — set up the server, sideload the
  app, and configure it on first run.
- **[User guide](user-guide.md)** — every feature, the keypad reference, and
  [troubleshooting](user-guide.md#troubleshooting).
- **[Remote access](remote-access.md)** — a reverse proxy with Basic Auth, and
  the one WebSocket caveat to know about.

## For developers

- **[Architecture](architecture.md)** — receive/send flow, module reference,
  IndexedDB schema, and normalized event shapes.
- **[Development](development.md)** — Gecko 48 constraints, packaging, desktop
  dev, conventions, and adding a screen.
- **[AGENTS.md](../AGENTS.md)** — condensed rules for AI agents (and a fast
  orientation for humans).

## How the pieces fit together

```
                            your home network / a reverse proxy
                                          │
   ┌───────────────┐   HTTP + WebSocket   │   ┌───────────────────────┐
   │  signal4kaios │◀────────────────────▶│──▶│  signal-cli-rest-api   │──▶ Signal
   │  (KaiOS app)  │                       │   │  (json-rpc mode)       │
   └───────────────┘                       │   └───────────────────────┘
```

The app is only a client. Your Signal account lives on the server, which must be
**registered or linked** and running in **`json-rpc`** mode. The phone reaches it
over Wi-Fi or through a reverse proxy (see [Remote access](remote-access.md)).
