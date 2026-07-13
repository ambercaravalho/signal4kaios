# signal4kaios

Real Signal, on a phone with actual buttons. **signal4kaios** is a Signal
messenger client for **KaiOS 2.5** feature phones, powered by a self-hosted
[signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) server on
your network.

Written in vanilla JavaScript with **zero build step**, and packaged as a
**privileged** KaiOS app — required for `systemXHR`, which lets the app talk to
your server across origins without CORS.

## Highlights

- Real-time 1:1 and group chat (WebSocket receive, `json-rpc` mode) with
  reactions (a full emoji picker, plus a "who reacted" view), replies, edits,
  read receipts, and typing indicators — the last two switchable off if you'd
  rather stay mysterious.
- **Disappearing messages** — set the timer per chat, see the countdown in a
  message's info, and watch messages delete themselves when they expire.
- **Pinned messages** in groups (synced through the group pin endpoint) and
  **pinned conversations** that float to the top of your list.
- **Attachments**: attach any file through the KaiOS system picker (which itself
  covers camera, recorder, gallery, and video) — all cached offline in IndexedDB
  and saveable to the phone.
- **Full group management**: add/remove members, promote or demote admins, set
  who can add members / edit the group / send messages, manage the invite link,
  and block a group.
- **QR codes**: share your Signal profile as a scannable code, and scan someone
  else's (best-effort with the camera).
- Find people fast: search-as-you-type in New chat, or start one by phone number
  or Signal username (with a "is this even registered?" check).
- Manage the little things: edit your own profile, rename contacts, verify
  safety numbers, and review who you've blocked.
- Juggle more than one number with multiple accounts, each with its own local
  history.
- Jump straight from a search result to that message in the thread.
- Archived and muted chats (with an optional "keep muted chats archived"),
  unread badges, local message search, and a reconnect that keeps trying (and
  wakes up) so you miss as little as possible.
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

Contributing or using an AI agent on this repo? Read **[AGENTS.md](AGENTS.md)**
for the condensed rules (Gecko 48 bans, conventions, definition of done).

## License

See [LICENSE](LICENSE).
