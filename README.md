# signal4kaios

**Real Signal, on a phone with actual buttons.**

signal4kaios is a full-featured [Signal](https://signal.org) messenger for
**KaiOS** feature phones — the flip phones and keypad handsets that don't run
Android or iOS. Send and receive real Signal messages, react, reply, join
groups, and share photos, all driven by the number pad and D-pad.

It connects to your own self-hosted Signal backend, so your messages never pass
through anyone else's servers. Works on **KaiOS 2.5, 3.0, 3.1, and 4.0** from a
single install.

> **You'll need to run a small backend** (two Docker containers) that holds your
> Signal account and talks to the phone. See the [Quickstart](#quickstart).

## Features

| Area | What you get |
| --- | --- |
| **Messaging** | Real-time 1:1 and group chat, reactions (full emoji picker + "who reacted"), replies, edits, read receipts, and typing indicators (last two toggleable) |
| **Disappearing messages** | Per-chat timer, live countdown on a message, and automatic deletion when it expires |
| **Notifications** | Background push (KaiOS 3.0+) that reaches you even when the app is fully closed — always on, nothing to configure |
| **Never miss a message** | The backend buffers anything that arrives while you're offline and replays it on reconnect |
| **Media** | Send/receive photos, video, voice notes, and files via the KaiOS system picker; cached offline and saveable to the phone |
| **Groups** | Manage members, admins, per-action permissions, invite links, pinned messages, and group blocking |
| **Finding people** | Search-as-you-type, or start a chat by number/username with a registration check |
| **Organization** | Multiple accounts, archived/muted chats, pinned conversations, unread badges, and local search |
| **Built for the hardware** | Fully keypad-driven, tuned for a 240x320 screen, with persistent reconnect |

## Requirements

- A **KaiOS 2.5 / 3.0 / 3.1 / 4.0** phone with the developer/debug menu enabled.
- **Docker** (with Compose) to run the backend.
- A desktop to package and sideload the app (WebIDE on 2.5, `appscmd` on 3.0+).

## Quickstart

1. **Start the backend** — signal-cli-rest-api (holds your Signal account) and
   the gateway (the only thing the phone talks to):

```sh
cp docker/.env.example docker/.env
docker compose -f docker/docker-compose.yml up -d
```

2. **Register or link** your Signal number on signal-cli-rest-api — a one-time
   step covered in [Getting started](docs/getting-started.md).
3. **Install the app**: `sh app/scripts/package.sh`, then sideload it (WebIDE on
   2.5, `appscmd` on 3.0/3.1/4.0).
4. **Point it at the backend**: on first run, set **Server URL** to the gateway
   (e.g. `http://<host>:8090`) and enter your Signal number.

Full walkthrough: **[Getting started](docs/getting-started.md)**.

## How it works

The phone app is a client only — your Signal account lives on the backend. Two
pieces run server-side:

- **[signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api)** —
  holds the account and does the actual Signal protocol work. It stays on an
  internal network and is never exposed to the phone.
- **[gateway](docs/gateway.md)** — a small Node/TypeScript service the app talks
  to. It proxies the API, relays the receive stream while buffering missed
  messages for gapless reconnects, and sends background push so notifications
  arrive even when the app is closed.

The app itself is vanilla JavaScript with **no build step**, packaged as a
**privileged** KaiOS app (privilege grants the cross-origin `systemXHR` it needs
to reach your server). One package installs on every supported version — it ships
both the 2.5 `manifest.webapp` and the 3.0+ `manifest.webmanifest`, and the OS
picks whichever it understands.

## Documentation

Full docs live in **[`docs/`](docs/README.md)**:

- **[Getting started](docs/getting-started.md)** — backend setup, install, first-run config.
- **[User guide](docs/user-guide.md)** — every feature and the keypad reference.
- **[Gateway](docs/gateway.md)** — the Node/TS backend: HTTP proxy, buffered WS relay, background push.
- **[Remote access](docs/remote-access.md)** — reverse proxy, auth modes, and the WebSocket caveat.
- **[Architecture](docs/architecture.md)** — data flow, modules, IndexedDB, event shapes.
- **[Development](docs/development.md)** — Gecko 48 constraints, cross-version support, packaging, adding a screen.

Contributing (or pointing an AI agent at this repo)? Start with
**[AGENTS.md](AGENTS.md)**.

## License

See [LICENSE](LICENSE).
