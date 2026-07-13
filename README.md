# signal4kaios

Real Signal, on a phone with actual buttons. **signal4kaios** is a Signal
messenger client for **KaiOS 2.5** feature phones, backed by a self-hosted
[signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) server on
your network.

It's vanilla JavaScript with **no build step**, packaged as a **privileged**
KaiOS app (privilege is what grants `systemXHR`, so the app can reach your server
cross-origin without CORS).

## Highlights

- Real-time 1:1 and group chat over the receive WebSocket (`json-rpc` mode):
  reactions (full emoji picker + a "who reacted" view), replies, edits, read
  receipts, and typing indicators (the last two toggleable).
- **Disappearing messages**: set the timer per chat, see a message's countdown,
  and messages delete themselves when they expire.
- **Pinning**: synced pinned messages in groups, plus local pinned conversations
  that float to the top of the list.
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

1. Run a **signal-cli-rest-api** server in `json-rpc` mode, registered/linked to
   your account and reachable from the phone.
2. Package the app: `sh tools/package.sh` (or point WebIDE at `app/`).
3. Sideload it and, on first run, enter your server URL and Signal number.

Full steps: **[Getting started](docs/getting-started.md)**.

## Documentation

The wiki lives in **[`docs/`](docs/README.md)**:

- **[Getting started](docs/getting-started.md)** — server setup, install, first-run config.
- **[User guide](docs/user-guide.md)** — every feature and the keypad reference.
- **[Remote access](docs/remote-access.md)** — reverse proxy, Basic Auth, and the WebSocket caveat.
- **[Architecture](docs/architecture.md)** — data flow, modules, IndexedDB, event shapes.
- **[Development](docs/development.md)** — Gecko 48 constraints, packaging, adding a screen.

Contributing (or pointing an AI agent at this repo)? Start with
**[AGENTS.md](AGENTS.md)**.

## License

See [LICENSE](LICENSE).
