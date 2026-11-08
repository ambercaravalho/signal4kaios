# signal4kaios

*real Signal, on a phone with actual buttons.*

signal4kaios is a standalone, full-featured [Signal](https://signal.org) messenger for **KaiOS 3.0, 3.1, and 4.0** feature phones. Send and receive end-to-end encrypted messages, react, reply, join groups, verify safety numbers, and share photos — all driven by the number pad and D-pad, with **no computer, Docker backend, or gateway required**.

## Screenshots

img1

img2

img3

## How it works

In v2.0.0, **Signal encryption and decryption run directly on your KaiOS phone**. The phone links to your Signal account as a secondary device (just like Signal Desktop) by displaying a `sgnl://linkdevice` QR code on screen, holds its own Curve25519 / X3DH / Double Ratchet / Sender Key state in IndexedDB, and connects directly to Signal's servers (`chat.signal.org` and `cdn.signal.org`).

## Quickstart

1. **Install the app.** Get `signal4kaios-2.0.0.zip` from [Releases](https://github.com/ambercaravalho/signal4kaios/releases). On KaiOS 3.0, 3.1, or 4.0, copy the ZIP to the phone and install it from OStore's **Manual Install** tab → **Install app from sdcard** (or sideload with `appscmd`; see [Setup](docs/setup.md)).
2. **Link your Signal account.** Open Signal4KaiOS on your KaiOS phone; it displays a linking QR code. On your main phone, open Signal → **Settings → Linked devices → Link a new device** and scan the QR code on the KaiOS screen.
3. **Start chatting.** Your contacts and groups sync directly from your primary Signal device.

The full walkthrough is in **[Setup](docs/setup.md)**.

## Features

| Area | What you get |
| --- | --- |
| **On-device E2EE** | X3DH, Double Ratchet, Sealed Sender, Sender Keys, and AES-256 attachment encryption directly on the phone |
| **Messaging** | Real-time 1:1 and group chat, reactions, replies, edits, read receipts, and typing indicators |
| **Disappearing messages** | Per-chat timer, live countdown on a message, and automatic deletion when it expires |
| **Offline queue** | Signal servers hold messages while your phone is offline and deliver them when you reconnect |
| **Media** | Send/receive encrypted photos, video, voice notes, and files directly via Signal CDN |
| **Safety numbers** | On-device 60-digit safety number calculation and QR code verification |
| **Organization** | Multiple accounts, archived/muted chats, pinned conversations, unread badges, and local search |

## Documentation

- **[Setup](docs/setup.md)**: installing on KaiOS 3.0/3.1/4.0, linking your Signal account, and troubleshooting.
- **[User guide](docs/user-guide.md)**: every feature and the keypad reference.
- **[Development](docs/development.md)**: architecture, the on-device Signal protocol engine, testing, and releasing.

Contributing (or pointing an AI agent at this repo)? Start with **[AGENTS.md](AGENTS.md)**.

## License

[GPL-3.0](LICENSE).
