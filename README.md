# signal4kaios

Real Signal, on a phone with actual buttons. **signal4kaios** is a Signal
messenger client for **KaiOS 2.5, 3.0, 3.1, and 4.0** feature phones, backed by a
self-hosted
[signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) server —
fronted by the signal4kaios **[gateway](docs/gateway.md)**, a small Node/TS
service the app talks to that proxies the API, buffers missed messages for gapless
reconnects, and delivers background push while the app is closed.

It's vanilla JavaScript with **no build step**, packaged as a **privileged**
KaiOS app (privilege is what grants `systemXHR`, so the app can reach your server
cross-origin without CORS). One package installs on every supported version — it
ships both the 2.5 `manifest.webapp` and the 3.0+ `manifest.webmanifest`.

## Highlights

- Real-time 1:1 and group chat over the receive WebSocket (`json-rpc` mode):
  reactions (full emoji picker + a "who reacted" view), replies, edits, read
  receipts, and typing indicators (the last two toggleable).
- **Disappearing messages**: set the timer per chat, see a message's countdown,
  and messages delete themselves when they expire.
- **Pinning**: synced pinned messages in groups, plus local pinned conversations
  that float to the top of the list.
- **Background notifications** (KaiOS 3.0+): the gateway sends Web Push so new
  messages notify you even when the app is fully closed — always on, no setup.
- **Gapless reconnect**: the gateway buffers what arrives while you're offline and
  replays your backlog on reconnect, so nothing is missed.
- **Attachments** through the KaiOS system picker (camera, recorder, gallery,
  video, or any file), cached offline and saveable to the phone.
- **Group management**: members, admins, per-action permissions, invite link,
  and group blocking.
- **QR codes**: show your Signal profile code and scan someone else's.
- **Finding people**: search-as-you-type, or start by number/username with a
  registration check.
- Multiple accounts, archived/muted chats, unread badges, local search, and a
  persistent reconnect. Fully keypad-driven for a 240x320 screen.

## Quickstart

1. Start the backend (signal-cli-rest-api + gateway) with Docker:

```sh
cp docker/.env.example docker/.env
docker compose -f docker/docker-compose.yml up -d
```

2. Register or link your Signal number on signal-cli-rest-api (one-time — see
   [Getting started](docs/getting-started.md)).
3. Package and sideload the app: `sh app/scripts/package.sh` (WebIDE on 2.5,
   `appscmd` on 3.0/3.1/4.0).
4. On first run, set **Server URL** to the gateway (e.g. `http://<host>:8090`)
   and your Signal number.

Full steps: **[Getting started](docs/getting-started.md)**.

## Documentation

The wiki lives in **[`docs/`](docs/README.md)**:

- **[Getting started](docs/getting-started.md)** — backend setup, install, first-run config.
- **[User guide](docs/user-guide.md)** — every feature and the keypad reference.
- **[Gateway](docs/gateway.md)** — the Node/TS backend: HTTP proxy, buffered WS relay, background push.
- **[Remote access](docs/remote-access.md)** — reverse proxy, Basic Auth, and the WebSocket caveat.
- **[Architecture](docs/architecture.md)** — data flow, modules, IndexedDB, event shapes.
- **[Development](docs/development.md)** — Gecko 48 constraints, cross-version support, packaging, adding a screen.

Contributing (or pointing an AI agent at this repo)? Start with
**[AGENTS.md](AGENTS.md)**.

## License

See [LICENSE](LICENSE).
