# signal4kaios

**Real Signal, on a phone with actual buttons.**

signal4kaios is a full-featured [Signal](https://signal.org) messenger for **KaiOS** feature phones — the flip phones and keypad handsets that don't run Android or iOS. Send and receive real Signal messages, react, reply, join groups, and share photos, all driven by the number pad and D-pad.

It connects to your own self-hosted Signal backend, so your messages never pass through anyone else's servers. Works on **KaiOS 2.5, 3.0, 3.1, and 4.0** from a single install.

> **You need to run a small backend** (two Docker containers) on a computer or server you control. The app does nothing without it.

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

## Quickstart

1. **Start the backend** on a computer with Docker:

   ```sh
   cp docker/.env.example docker/.env
   docker compose -f docker/docker-compose.yml up -d
   ```

2. **Link your Signal account** to it as a linked device, like Signal Desktop.
3. **Install the app and pair it.** On KaiOS 3.0+, install Signal4KaiOS from [OStore](https://github.com/Samenal-sys/Store) (or add the source `https://ambercaravalho.github.io/signal4kaios/`). On 2.5, sideload a ZIP from [Releases](https://github.com/ambercaravalho/signal4kaios/releases). Open the app and enter the gateway's address plus the pairing code it prints (`docker compose -f docker/docker-compose.yml logs gateway`).

The full walkthrough, including use away from home, is in **[Setup](docs/setup.md)**.

## How it works

The phone app is only a client. Your Signal account lives on [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api), which stays on an internal network. The phone talks to the **gateway** in front of it, which proxies the API, buffers messages so none are missed while you're offline, sends background push, and only accepts phones you've paired with a one-time code.

## Documentation

- **[Setup](docs/setup.md)**: backend, install, pairing, remote access, and troubleshooting.
- **[User guide](docs/user-guide.md)**: every feature and the keypad reference.
- **[Development](docs/development.md)**: architecture, the gateway and its protocols, testing, and releasing.

Contributing (or pointing an AI agent at this repo)? Start with **[AGENTS.md](AGENTS.md)**.

## License

[GPL-3.0](LICENSE).
