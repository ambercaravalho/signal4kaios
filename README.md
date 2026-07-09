# signal4kaios

A Signal messenger client for **KaiOS 2.5** feature phones, powered by a
[signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) server
running on your home network.

Vanilla JS, zero build step, packaged as a **privileged** KaiOS app
(needed for `systemXHR`, which lets the app talk to your server without CORS).

## Features

- Conversation list with unread badges, typing dots, and live connection status
- 1:1 and group chats with contact/group names from the server
- Send & receive text messages in real time (WebSocket, json-rpc mode)
- Reactions (Signal's six defaults), read receipts, typing indicators
- Quote/reply, copy to composer, delete for everyone, retry failed sends
- **Edit sent messages**, and see edits made by others (or by you on the phone)
- **Inline photo thumbnails** in chat (small images auto-download; all cached
  offline in IndexedDB) plus a full-screen viewer
- **Send photos** from the gallery (picked via MozActivity, downscaled on-device)
- **Voice messages / audio attachments** play in the viewer; any attachment can
  be **saved to the phone** (gallery/music/files via DeviceStorage)
- **Real profile photos** for contacts and groups (fetched once, cached)
- Full contact-name resolution (address book → nickname → profile → username)
- **Local message search** across all stored history
- **Archived chats** (hidden behind an "Archived chats" row; any new message
  brings a chat back) and **muted chats** (badge stays, notifications stop) —
  both local to the phone, since the REST API does not expose Signal's synced
  chat-list state
- Colored initial avatars as fallback
- Message history persisted on the phone (IndexedDB) — the REST API has no
  history endpoint, so history accrues from the moment you start using the app
- Start new chats from your contact/group list
- Notifications when the app is in the background
- Configurable server URL and account number (Settings)

## Requirements

- A phone running KaiOS 2.5 (Gecko 48) with the debug menu enabled
- signal-cli-rest-api running in **json-rpc** mode (`MODE=json-rpc`), already
  registered/linked to your Signal account, reachable from the phone's Wi-Fi
  (e.g. `http://192.168.1.100:4329`)

## Install (sideload)

1. `tools/package.sh` — checks the code for Gecko-48-incompatible syntax and
   produces `dist/signal4kaios.zip` (or point WebIDE at the `app/` directory
   directly).
2. On the phone, enable debug mode: dial `*#*#33284#*#*` (a bug icon appears).
3. Connect USB, then `adb forward tcp:6000 localfilesystem:/data/local/debugger-socket`.
4. In an old Firefox (52–59) open **WebIDE** → Remote Runtime → `localhost:6000`.
5. *Open Packaged App* → select the `app/` folder → Install & Run.
6. First run opens Settings: enter your server URL and Signal number, hit
   **Test connection**, then **Save**.

## Keys

| Key | Conversations | Chat |
|---|---|---|
| Up/Down | Move selection | Move through messages / composer |
| Center | Open chat | Send (composer) / message options (message) |
| SoftLeft | Options (search, settings) | Cancel reply / cancel edit |
| SoftRight | New chat | Attach photo |
| Back | Exit app | Back to list |

## Development on the desktop

The HTTP layer falls back to a plain XHR when `mozSystem` is unavailable, so
you can develop in a desktop browser:

```sh
# serve the app
cd app && python3 -m http.server 8000
# proxy the API to add CORS headers (websocket passes through fine)
npx local-cors-proxy --proxyUrl http://192.168.1.100:4329 --port 4330
```

Then set the in-app server URL to the proxy. Note the desktop browser will not
enforce the privileged-app CSP (`default-src 'self'`) — keep scripts/styles
local and inline-free, and verify in the KaiOS simulator (kaiosrt via WebIDE)
before shipping to the phone.

**Gecko 48 rules** (enforced by `tools/package.sh`): no `async`/`await`, no
spread/rest `...`, no `padStart`, no CSS grid, no ES modules, no inline event
handlers.

## Architecture

```
ws.js ──▶ normalize.js ──▶ store.js ──▶ IndexedDB (db.js)
 (receive)   (envelope→events)   │
                                 └──▶ emits events ──▶ screens/* patch the DOM
router.js: screen stack + single global keydown dispatcher
nav.js:    D-pad selection via nav-selectable / nav-selected attributes
http.js:   mozSystem XHR (privileged, CORS-free) with desktop fallback
```

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
