# signal4kaios

*real Signal, on a phone with actual buttons.*

signal4kaios is a full-featured [Signal](https://signal.org) messenger for **KaiOS** feature phones. Send and receive messages, react, reply, join groups, and share photos, all driven by the number pad and D-pad.

> [!IMPORTANT]
> **You need to run a small backend** (two Docker containers) on a computer or server you control. The app does nothing without it.

## Screenshots

img1

img2

img3

## How it works

The phone app is only a client. Your Signal account lives on [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api), which stays on an internal network. The phone talks to the **gateway** in front of it, which proxies the API, buffers messages so none are missed while you're offline, sends background push, and only accepts phones you've paired with a one-time code.

## Quickstart

1. **Start the backend** on a computer with Docker. Both containers are prebuilt images, so nothing is built locally:

   ```sh
   git clone --depth 1 https://github.com/ambercaravalho/signal4kaios.git && cd signal4kaios
   docker compose -f docker/docker-compose.yml up -d
   ```

2. **Link your Signal account** to it as a linked device, like Signal Desktop: run `docker compose -f docker/docker-compose.yml exec gateway npm run link` and scan the QR code it shows from Signal's **Linked devices** screen.
3. **Install the app and pair it.** Get the ZIP from [Releases](https://github.com/ambercaravalho/signal4kaios/releases). On KaiOS 3.0+, copy it to the phone and install it from OStore's **Manual Install** tab (or sideload with `appscmd`); on 2.5, sideload it with WebIDE (see [Setup](docs/setup.md#3-install-the-app)). Open the app and enter the gateway's address plus the pairing code it prints (`docker compose -f docker/docker-compose.yml logs gateway`).

The full walkthrough, including use away from home, is in **[Setup](docs/setup.md)**.

## Features

| Area | What you get |
| --- | --- |
| **Messaging** | Real-time 1:1 and group chat, reactions, replies, edits, read receipts, and typing indicators |
| **Disappearing messages** | Per-chat timer, live countdown on a message, and automatic deletion when it expires |
| **Notifications** | Background push (KaiOS 3.0+) that reaches you even when the app is fully closed |
| **Never miss a message** | The backend buffers anything that arrives while you're offline |
| **Media** | Send/receive photos, video, voice notes, and files |
| **Groups** | Manage members, admins, per-action permissions, invite links, and pinned messages |
| **Finding people** | Search-as-you-type, or start a chat by number/username with a registration check |
| **Organization** | Multiple accounts, archived/muted chats, pinned conversations, unread badges, and local search |

## Documentation

- **[Setup](docs/setup.md)**: backend, install, pairing, remote access, and troubleshooting.
- **[User guide](docs/user-guide.md)**: every feature and the keypad reference.
- **[Development](docs/development.md)**: architecture, the gateway and its protocols, testing, and releasing.

Contributing (or pointing an AI agent at this repo)? Start with **[AGENTS.md](AGENTS.md)**.

## License

[GPL-3.0](LICENSE).
