<div align="center">

<img src="src/app/assets/icons/beacon.svg" alt="Beacon icon" width="112">

# Beacon

**An unofficial, standalone [Signal](https://signal.org) client for KaiOS 3.0, 3.1, and 4.0 feature phones.**

[**Download**](https://github.com/ambercaravalho/signal4kaios/releases/latest) · [Quickstart](#quickstart) · [Features](#features) · [Documentation](#documentation)

[![CI](https://github.com/ambercaravalho/signal4kaios/actions/workflows/ci.yml/badge.svg)](https://github.com/ambercaravalho/signal4kaios/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/ambercaravalho/signal4kaios?include_prereleases)](https://github.com/ambercaravalho/signal4kaios/releases) [![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

<table>
  <tr>
    <td align="center"><img src="docs/images/welcome.png" alt="Welcome screen with the Beacon icon and a Start softkey" width="200"><br><sub><b>Link in a minute</b></sub></td>
    <td align="center"><img src="docs/images/chats.png" alt="Chat list in the All chats folder with a pinned chat, a group, unread counts, a typing indicator, and a muted chat" width="200"><br><sub><b>Chats, groups, and folders</b></sub></td>
    <td align="center"><img src="docs/images/chat-dark.png" alt="A conversation in dark mode with a reply, bold text, a reaction, read ticks, and a voice message" width="200"><br><sub><b>Replies, reactions, voice messages</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/group-poll.png" alt="A group chat with a poll showing vote counts and the option you picked" width="200"><br><sub><b>Polls in groups</b></sub></td>
    <td align="center"><img src="docs/images/call.png" alt="A voice call in progress with Speaker, Mute, and End softkeys" width="200"><br><sub><b>One-to-one voice calls</b></sub></td>
    <td align="center"><img src="docs/images/about.png" alt="About Beacon with the version, Check for updates, and automatic update checks turned on" width="200"><br><sub><b>Updates built in</b></sub></td>
  </tr>
</table>

</div>

> [!NOTE]
> Beacon is a work in progress. Everyday messaging, groups, sync, and one-to-one voice calls work, but some Signal features don't; [Known limitations](docs/user-guide.md#known-limitations) lists them. Video calls, group calls, stories, and payments won't be added.

## Why Beacon

- **It's really Signal.** Your messages use the same end-to-end encryption as the official apps, and they reach the people you talk to on Android, iPhone, and Desktop as normal Signal messages.
- **Private by design.** Keys are created and kept on the phone. There's no gateway, no bridge, and no computer to leave running.
- **Built for keypads.** Lists, menus, and softkeys follow KaiOS conventions, so every action is a few key presses away and nothing needs a touchscreen.

## Quickstart

You need a KaiOS 3.0, 3.1, or 4.0 phone and a Signal account on your main phone.

1. **Install.** Download `signal4kaios-<version>.zip` from [Releases](https://github.com/ambercaravalho/signal4kaios/releases) and install it from OStore's **Manual Install** tab, or sideload it with [`appscmd`](https://github.com/kaiostech/appscmd).
2. **Link.** Open Beacon and press **Start**; it shows a QR code. On your main phone, go to Signal → **Settings → Linked devices → Link a new device** and scan it.
3. **Chat.** Contacts and groups sync from your account within a minute.

The [setup guide](docs/setup.md) covers every install route and what to do if something goes wrong.

## Features

| Area | What you get |
| --- | --- |
| **Encryption** | libsignal on the phone: PQXDH, Double Ratchet, Sealed Sender, Sender Keys, safety numbers, and AES-256 attachment encryption |
| **Messaging** | 1:1 and group chats, reactions, replies, edits, delete for everyone, read receipts, typing indicators, text formatting, polls, and link previews |
| **Privacy** | A screen lock PIN, Signal proxy support, who can see and find your number, read receipt and typing controls, and blocking |
| **Disappearing messages** | Per-chat timer, a timer icon on each message with a live countdown in its details, and automatic deletion |
| **Media** | Encrypted photos, video, voice notes, and files via Signal's CDNs; record voice messages with waveforms, blurred previews, and your own profile photo |
| **Voice calls** | One-to-one Signal voice calls on the earpiece or loudspeaker, with mute, always relayed through Signal's servers, and call history shared with your other devices |
| **Sync** | Contacts, groups, blocked list, and profiles from Signal's Storage Service and your primary device; number changes are followed; nicknames, blocking, archive, mute, mentions in muted groups, pinned chats, your profile photo, and your username sync back |
| **Groups** | Rename, description, timer, members, admins, invites, permissions, group links, joining by link, leave, and block, as real Groups V2 changes |
| **Organization** | Multiple accounts, archived, muted, and pinned chats, pinned messages, a Signal username with its QR code, and local search |

For what isn't supported, see [Known limitations](docs/user-guide.md#known-limitations).

## Documentation

| Guide | Covers |
| --- | --- |
| [Setup](docs/setup.md) | Installing, linking, and troubleshooting |
| [User guide](docs/user-guide.md) | Every feature and the keypad reference |
| [Architecture](docs/architecture.md) | How the app, the engine, and libsignal fit together |
| [Development](docs/development.md) | Building, testing, bumping pins, and releasing |
| [Changelog](CHANGELOG.md) | Release notes |
| [Known limitations](docs/user-guide.md#known-limitations) | Signal features Beacon doesn't support, and why |

## Contributing

Bug reports and pull requests are welcome. [Development](docs/development.md) explains how to build the app and the libsignal wrapper, run the tests, and package a release; please [open an issue](https://github.com/ambercaravalho/signal4kaios/issues) before starting on anything large.

## License

[GPL-3.0](LICENSE). The app bundles Signal's [libsignal](https://github.com/signalapp/libsignal) (AGPL-3.0-only) compiled to WebAssembly; GPL-3.0 section 13 permits that combination. See [NOTICE](NOTICE).

Beacon is an independent project and is not affiliated with or endorsed by Signal Messenger, LLC or KaiOS Technologies.
