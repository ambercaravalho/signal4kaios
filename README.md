# signal4kaios

A Signal messenger client for **KaiOS 2.5** feature phones, powered by a
self-hosted
[signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) server on
your network.

Written in vanilla JavaScript with **zero build step**, and packaged as a
**privileged** KaiOS app — required for `systemXHR`, which lets the app talk to
your server across origins without CORS.

## Highlights

- Real-time 1:1 and group chat (WebSocket receive, `json-rpc` mode) with
  reactions, replies, edits, read receipts, and typing indicators.
- Inline photos, voice messages, and attachments — cached offline in IndexedDB,
  saveable to the phone.
- Archived and muted chats, unread badges, and local message search.
- Fully keypad-driven, tuned for a 240×320 screen.

## Quickstart

1. Run a **signal-cli-rest-api** server in `json-rpc` mode, registered/linked to
   your Signal account and reachable from the phone.
2. Package the app: `sh tools/package.sh` (or point WebIDE at `app/`).
3. Sideload it onto the phone and, on first run, enter your server URL and Signal
   number.

Full steps are in **[Getting started](docs/getting-started.md)**.

## Documentation

The full wiki lives in **[`docs/`](docs/README.md)**:

- **[Getting started](docs/getting-started.md)** — requirements, server setup,
  install/sideload, first-run config.
- **[User guide](docs/user-guide.md)** — every feature, plus the keypad
  reference.
- **[Remote access](docs/remote-access.md)** — reverse proxy + Basic Auth, and
  the WebSocket caveat.
- **[Architecture](docs/architecture.md)** — data flow, modules, IndexedDB, event
  shapes.
- **[Development](docs/development.md)** — Gecko 48 constraints, packaging,
  desktop dev, adding a screen.
- **[Roadmap](docs/roadmap.md)** — what's not built yet.

Contributing or using an AI agent on this repo? Read **[AGENTS.md](AGENTS.md)**
for the condensed rules (Gecko 48 bans, conventions, definition of done).

## License

See [LICENSE](LICENSE).
