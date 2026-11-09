# Beacon

*Real Signal, on a phone with actual buttons.*

[![CI](https://github.com/ambercaravalho/signal4kaios/actions/workflows/ci.yml/badge.svg)](https://github.com/ambercaravalho/signal4kaios/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/ambercaravalho/signal4kaios?include_prereleases)](https://github.com/ambercaravalho/signal4kaios/releases) [![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

Beacon (this repository, signal4kaios) is an unofficial, standalone [Signal](https://signal.org) client for **KaiOS 3.0, 3.1, and 4.0** feature phones. It links to your Signal account as a [linked device](https://support.signal.org/hc/en-us/articles/360007320551), like Signal Desktop, and runs all encryption on the phone with Signal's official [libsignal](https://github.com/signalapp/libsignal) compiled to WebAssembly. Everything is driven by the D-pad and number keys.

> [!NOTE]
> Beacon is a work in progress. Everyday messaging, groups, and sync work, but calls, stories, link previews, polls, and some other Signal features don't yet. The [roadmap](https://github.com/ambercaravalho/signal4kaios/issues?q=is%3Aissue%20state%3Aopen%20label%3Aroadmap) tracks everything that's missing.

## Screenshots

img1

img2

img3

## Quickstart

1. **Install.** Download `signal4kaios-<version>.zip` from [Releases](https://github.com/ambercaravalho/signal4kaios/releases) and install it from OStore's **Manual Install** tab, or sideload it with [`appscmd`](https://github.com/kaiostech/appscmd).
2. **Link.** Open Beacon and press **Start**; it shows a QR code. On your main phone, go to Signal → **Settings → Linked devices → Link a new device** and scan it.
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
| **Sync** | Contacts, groups, blocked list, and profiles from Signal's Storage Service and your primary device; nicknames, blocking, archive, mute, pinned chats, and your username sync back |
| **Groups** | Rename, description, timer, members, admins, invites, permissions, group links, leave, and block, as real Groups V2 changes |
| **Organization** | Multiple accounts, archived, muted, and pinned chats, pinned messages, a Signal username with its QR code, and local search |
| **Design** | KaiOS-style lists, softkeys, and menus with Signal's colors, light and dark themes, and plain-language wording; technical details live in **Settings → Debug** |

For what isn't supported yet, see [Known limitations](docs/user-guide.md#known-limitations) and the [roadmap](https://github.com/ambercaravalho/signal4kaios/issues?q=is%3Aissue%20state%3Aopen%20label%3Aroadmap).

## Documentation

| Guide | Covers |
| --- | --- |
| [Setup](docs/setup.md) | Installing, linking, KaiOS 4.0 WebAssembly, and troubleshooting |
| [User guide](docs/user-guide.md) | Every feature and the keypad reference |
| [Architecture](docs/architecture.md) | How the app, the engine, and libsignal fit together |
| [Development](docs/development.md) | Building, testing, bumping pins, and releasing |
| [Changelog](CHANGELOG.md) | Release notes |
| [Roadmap](https://github.com/ambercaravalho/signal4kaios/issues?q=is%3Aissue%20state%3Aopen%20label%3Aroadmap) | Signal features that aren't supported yet, by area |

## License

[GPL-3.0](LICENSE). The app bundles Signal's [libsignal](https://github.com/signalapp/libsignal) (AGPL-3.0-only) compiled to WebAssembly; GPL-3.0 section 13 permits that combination. See [NOTICE](NOTICE).

Beacon is an independent project and is not affiliated with or endorsed by Signal Messenger, LLC or KaiOS Technologies.
