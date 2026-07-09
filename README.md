# signal4kaios

A Signal messenger client for **KaiOS 2.5** feature phones, powered by a
[signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) server
running on your home network.

Written in vanilla JavaScript with **zero build step**, and packaged as a
**privileged** KaiOS app — required for `systemXHR`, which lets the app talk
to your server across origins without CORS.

## Features

**Messaging**

- Send & receive text in real time (WebSocket receive, json-rpc mode)
- 1:1 and group chats, with names resolved from your address book, nicknames,
  and Signal profiles
- Reactions (Signal's six defaults), read receipts, typing indicators
- Quote/reply, copy to composer, delete for everyone, retry failed sends
- Edit sent messages — and see edits made by others or by you on another device
- Delivery ticks: pending → sent ✓ → delivered ✓✓ → read (blue)

**Media & attachments**

- Inline photo thumbnails in chat (small images auto-download; everything is
  cached offline in IndexedDB) plus a full-screen viewer
- Send photos from the gallery (MozActivity picker, downscaled on-device
  before upload)
- Voice messages and audio attachments play in the viewer; any attachment can
  be saved to the phone (gallery / music / files via DeviceStorage)
- Real profile photos for contacts and groups, with colored-initials fallback

**Organization**

- Conversation list with unread badges, typing dots, and connection status
- Archived chats — hidden behind an "Archived chats" row; any new message
  brings a chat back (local to the phone: the REST API does not expose
  Signal's synced chat-list state)
- Muted chats — unread badge keeps counting, notifications stop (🔇)
- Local message search across all stored history
- Start new chats from your contact and group list
- Notifications when the app is in the background

**Persistence**

Message history lives on the phone in IndexedDB — the REST API has no history
endpoint, so history accrues from the moment you start using the app. Old
messages are pruned to ~500 per conversation; viewed media is kept in a small
LRU cache.

## Requirements

- A phone running KaiOS 2.5 (Gecko 48) with the debug menu enabled
- signal-cli-rest-api running in **json-rpc** mode (`MODE=json-rpc`), already
  registered or linked to your Signal account, reachable from the phone's
  Wi-Fi (e.g. `http://192.168.1.100:4329`)

## Install (sideload)

1. Run `tools/package.sh` — it gates on Gecko-48-incompatible syntax and
   produces `dist/signal4kaios.zip` (or point WebIDE at the `app/` directory
   directly).
2. On the phone, enable debug mode: dial `*#*#33284#*#*` (a bug icon appears).
3. Connect USB, then
   `adb forward tcp:6000 localfilesystem:/data/local/debugger-socket`.
4. In an old Firefox (52–59) open **WebIDE** → Remote Runtime → `localhost:6000`.
5. *Open Packaged App* → select the `app/` folder → Install & Run.
6. First run opens Settings: enter your server URL and Signal number, hit
   **Test connection**, then **Save**.

Re-sideload after updates that change `manifest.webapp` permissions, or the
new permissions won't take effect.

## Keys

| Key | Conversations | Chat |
|---|---|---|
| Up/Down | Move selection | Move through messages / composer |
| Center | Open chat / archived list | Send (composer) · message options (message) |
| SoftLeft | Options: archive, mute, search, settings | Cancel reply / cancel edit |
| SoftRight | New chat | Attach photo |
| Back | Exit app | Back to list |

In the message options menu: view photo/attachment, react, reply, copy, edit,
delete for everyone, retry. In the attachment viewer: center plays/pauses
audio, SoftLeft saves to the phone. The archived list has its own SoftLeft
menu (unarchive, mute).

## Development on the desktop

The HTTP layer falls back to a plain XHR when `mozSystem` is unavailable, so
you can develop in a normal browser:

```sh
# serve the app
cd app && python3 -m http.server 8000
# proxy the API to add CORS headers (the websocket passes through fine)
npx local-cors-proxy --proxyUrl http://192.168.1.100:4329 --port 4330
```

Then set the in-app server URL to the proxy. Note that a desktop browser does
not enforce the privileged-app CSP — keep all scripts and styles in local
files with no inline handlers, and verify in the KaiOS 2.5 simulator (kaiosrt
via WebIDE) before trusting a change.

**Gecko 48 rules** (enforced by `tools/package.sh`): no `async`/`await`, no
spread/rest `…`, no `padStart`, no CSS grid, no ES modules, no inline event
handlers.

## Architecture

```
ws.js ──▶ normalize.js ──▶ store.js ──▶ IndexedDB (db.js)
 (receive)   (envelope→events)   │
                                 └──▶ emits events ──▶ screens/* patch the DOM
```

- `router.js` — screen stack with a single global keydown dispatcher
  (unhandled Backspace pops; KaiOS's Back key sends Backspace)
- `nav.js` — D-pad selection via `nav-selectable` / `nav-selected` attributes
- `http.js` — mozSystem XHR (privileged, CORS-free) with desktop fallback
- `api.js` — thin wrappers over the REST endpoints
- `store.js` — state hub: applies normalized events, persists, emits;
  serializes read-modify-write message updates so concurrent receipts and
  reactions can't clobber each other
- `avatars.js` — profile-photo fetch + cache with per-session memoization
- `js/screens/` — conversations, archived, chat, new chat, message options,
  reaction picker, attachment viewer, search, settings, debug log, and a
  generic menu

IndexedDB stores: `messages` (keyed `convId|timestamp|author`, indexed by
`[convId, timestamp]`), `conversations`, `contacts`, `attachments` (media +
avatar blob cache), `kv`. Settings → Debug log shows a ring buffer of
unhandled envelope shapes and network errors — the first place to look when
something doesn't appear.

## Roadmap (not yet implemented)

| Feature | Notes for implementation |
|---|---|
| Group info & management | show members/description (`GET /v1/groups/{number}/{groupid}`); create/update/leave |
| Safety numbers | list & verify via `/v1/identities/{number}` |
| Profile editing | set own name/avatar via `PUT /v1/profiles/{number}` |
| Polls | render incoming polls; create/vote via `/v1/polls/{number}` |
| Sticker packs | render incoming stickers; manage via `/v1/sticker-packs/{number}` |
| Registered-number check | `GET /v1/search` to validate manually entered numbers in New chat |
| Contact management | rename via `PUT /v1/contacts/{number}` + `/sync` |
| Jump-to-message from search | pass a target timestamp to the chat screen and page until reached |
| History backfill | no REST API for history — would need a companion export/import script on the server |
| Multi-account | per-account IndexedDB database + account switcher in Settings |
| Reconnect hardening | `alarms` permission to wake the app and reconnect the WebSocket |
