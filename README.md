# signal4kaios

*Real Signal, on a phone with actual buttons.*

[![CI](https://github.com/ambercaravalho/signal4kaios/actions/workflows/ci.yml/badge.svg)](https://github.com/ambercaravalho/signal4kaios/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/ambercaravalho/signal4kaios?include_prereleases)](https://github.com/ambercaravalho/signal4kaios/releases) [![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

signal4kaios is a standalone [Signal](https://signal.org) client for **KaiOS 3.0, 3.1, and 4.0** feature phones. It links to your Signal account as a [linked device](https://support.signal.org/hc/en-us/articles/360007320551), like Signal Desktop, and runs all encryption on the phone with Signal's official [libsignal](https://github.com/signalapp/libsignal) compiled to WebAssembly. Everything is driven by the D-pad and number keys.

## Screenshots

img1

img2

img3

## Quickstart

1. **Install.** Download `signal4kaios-<version>.zip` from [Releases](https://github.com/ambercaravalho/signal4kaios/releases) and install it from OStore's **Manual Install** tab, or sideload it with [`appscmd`](https://github.com/kaiostech/appscmd).
2. **Link.** Open the app; it shows a QR code. On your main phone, go to Signal → **Settings → Linked devices → Link a new device** and scan it.
3. **Chat.** Contacts and groups sync from your account within a minute.

> [!IMPORTANT]
> KaiOS 4.0 blocks WebAssembly by default. Do the one-time [rooted WebAssembly step](docs/setup.md#kaios-40-enable-webassembly) before the first launch.

## Features

| Area | What you get |
| --- | --- |
| **Encryption** | libsignal on the phone: PQXDH, Double Ratchet, Sealed Sender, Sender Keys, safety numbers, and AES-256 attachment encryption |
| **Messaging** | 1:1 and group chats, reactions, replies, edits, delete for everyone, read receipts, typing indicators, and text formatting |
| **Disappearing messages** | Per-chat timer, a live countdown on each message, and automatic deletion |
| **Media** | Encrypted photos, video, voice notes, and files via Signal's CDNs |
| **Sync** | Contacts, groups, blocked list, and profiles from Signal's Storage Service and your primary device |
| **Organization** | Multiple accounts, archived, muted, and pinned chats, and local search |

Some actions still only change local state on the phone; see [Known limitations](docs/user-guide.md#known-limitations).

## Documentation

| Guide | Covers |
| --- | --- |
| [Setup](docs/setup.md) | Installing, linking, KaiOS 4.0 WebAssembly, and troubleshooting |
| [User guide](docs/user-guide.md) | Every feature and the keypad reference |
| [Architecture](docs/architecture.md) | How the app, the engine, and libsignal fit together |
| [Development](docs/development.md) | Building, testing, bumping pins, and releasing |
| [Changelog](CHANGELOG.md) | Release notes |

## License

[GPL-3.0](LICENSE). The app bundles Signal's [libsignal](https://github.com/signalapp/libsignal) (AGPL-3.0-only) compiled to WebAssembly; GPL-3.0 section 13 permits that combination. See [NOTICE](NOTICE).

signal4kaios is an independent project and is not affiliated with or endorsed by Signal Messenger, LLC or KaiOS Technologies.
