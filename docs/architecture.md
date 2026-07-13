# Architecture

How the app is put together. For the rules when changing it see
[AGENTS.md](../AGENTS.md); for tooling and conventions see
[Development](development.md).

- [Design in one picture](#design-in-one-picture)
- [The receive path](#the-receive-path)
- [The send path](#the-send-path)
- [Module reference](#module-reference)
- [Screens and the router](#screens-and-the-router)
- [IndexedDB schema](#indexeddb-schema)
- [Normalized event shapes](#normalized-event-shapes)
- [Conversation and message records](#conversation-and-message-records)

## Design in one picture

Everything is vanilla ES5, no build step. Each file is an IIFE that hangs its
public API off a global `App`. The core data flow is one direction:

```
ws.js ──▶ normalize.js ──▶ store.js ──▶ IndexedDB (db.js)
(receive)  (frame→events)     │
                              └──▶ emits events ──▶ js/screens/* patch the DOM
```

Screens are pure consumers: they subscribe to store events and re-render, never
parsing frames or writing message data to IndexedDB directly — that all goes
through `App.store`.

## The receive path

1. **[`ws.js`](../app/js/ws.js)** maintains the WebSocket to
   `wss://<server>/v1/receive/<number>`, with backoff+jitter reconnect, a
   reconnect-on-foreground handler, a heartbeat for a silently-dead socket, and a
   wake alarm; after a reconnect it kicks off a directory resync. Each frame's
   JSON goes to `App.store.ingestRaw`.
2. **[`normalize.js`](../app/js/normalize.js)** is the single choke point that
   turns a raw signal-cli envelope into zero or more **typed events**. Envelope
   shapes vary across versions, so **all** parsing lives here and anything
   unrecognized is logged via `App.util.dbg` and skipped — never thrown.
3. **[`store.js`](../app/js/store.js)** applies each event: builds/updates
   conversation and message records, persists via `App.db`, and emits high-level
   events (`message`, `message-updated`, `conversations`, `typing`,
   `connection`, …) that screens listen to.

Read-modify-write updates to stored messages (reactions, receipts, edits,
deletes) run through a single serial queue (`enqueueMutation`) so concurrent
frames can't clobber each other.

## The send path

Screens call `App.store.sendText` / `sendAttachment` / `sendEdit` / `reactTo` /
etc., which:

1. Write an **optimistic** record (`status: 'pending'`) and emit so the UI shows
   it immediately.
2. Call the REST API via [`api.js`](../app/js/api.js) →
   [`http.js`](../app/js/http.js).
3. On success, re-key to the server's returned timestamp and mark `sent`; on
   failure mark `failed` (retryable from the message options).

## Module reference

Load order is defined in [`app/index.html`](../app/index.html); a module must
load after everything it depends on.

| File | Responsibility |
|---|---|
| [`polyfills.js`](../app/js/polyfills.js) | Tiny Gecko-48 shims; creates `window.App` |
| [`util.js`](../app/js/util.js) | `el`, time/format helpers, `initials`, `colorClass`, `debounce`, and the `dbg` ring buffer |
| [`config.js`](../app/js/config.js) | `localStorage` settings (server URL, number, proxy auth, receive token); feature flags; cached username+link; multi-account list; URL helpers |
| [`toast.js`](../app/js/toast.js) | `App.toast` transient message bar |
| [`http.js`](../app/js/http.js) | Promise wrapper over `mozSystem` XHR (CORS-free); desktop XHR fallback; attaches Basic Auth |
| [`api.js`](../app/js/api.js) | Wrappers over the REST endpoints (send, reactions, receipts, contacts/groups, group member/admin/permission/link/block management, message pin/unpin, set-username, disappearing-timer) |
| [`db.js`](../app/js/db.js) | IndexedDB persistence — the message history; includes the expired-message sweep and pinned-message query |
| [`normalize.js`](../app/js/normalize.js) | Envelope → typed events (the only parser) |
| [`ws.js`](../app/js/ws.js) | Receive WebSocket: backoff/reconnect, foreground+heartbeat+alarm wake, resync on reconnect, auth-failure detection |
| [`store.js`](../app/js/store.js) | State hub: apply events, persist, emit; optimistic send; serialized mutations |
| [`avatars.js`](../app/js/avatars.js) | Profile-photo fetch + cache with per-session memoization |
| [`nav.js`](../app/js/nav.js) | D-pad selection via `nav-selectable` / `nav-selected` |
| [`softkeys.js`](../app/js/softkeys.js) | SoftLeft/Center/SoftRight labels |
| [`router.js`](../app/js/router.js) | Screen stack + one global keydown dispatcher |
| [`main.js`](../app/js/main.js) | Boot: init router + store, push first screen, background prune |
| [`screens/*.js`](../app/js/screens) | Individual screens (see below) |

**Vendored libraries** live in [`app/vendor/`](../app/vendor), outside `app/js`
so the [packaging syntax gate](development.md#packaging) only scans first-party
code: `qrcode.js` (ES5 QR **encoder**, for showing your profile QR) and
`jsQR.js` (QR **decoder**, for scanning). They attach plain globals and load via
`<script>` tags. Scanning needs camera access, which varies across KaiOS builds:
`scanqr` tries a live `getUserMedia` preview (needs `video-capture`) and, if a
raw stream isn't granted, falls back to a MozActivity `pick` snapshot decoded
with jsQR.

## Screens and the router

**[`router.js`](../app/js/router.js)** owns a screen **stack** and a single
global `keydown` listener that dispatches to the top screen. Paused screens keep
their hidden DOM so scroll position and selection survive back-navigation.
Unhandled `Backspace` pops the stack (KaiOS's Back key sends Backspace);
preventing default is required or the system closes the app.

Screens follow a small `create()`-factory contract — see
[Development → Adding a screen](development.md#adding-a-screen). They live in
[`app/js/screens/`](../app/js/screens): conversations, archived, chat, newchat,
msgopts, msgview, reactions and emojipicker, viewer, qrcode and scanqr, search,
settings, profile, contactinfo, groupinfo, blocked, safety, debuglog, and the
reusable generic `menu` and single-field `textinput` building blocks.

## IndexedDB schema

Defined in [`db.js`](../app/js/db.js) (version 2). Since the REST API has no
history endpoint, **this database is the message history.** Each account gets its
own database `signal4kaios:<number>`; the first account predating multi-account
support keeps the un-suffixed `signal4kaios` name so its history survives.

| Store | Key | Notes |
|---|---|---|
| `messages` | `convId\|timestamp\|author` | Index `conv` on `[convId, timestamp]` for paging; pruned to ~500/conv; carries optional `pinned` and `expiresAt` for the pinned query and expiry sweep |
| `conversations` | peer number/uuid, or `g:` + internal group id | One per chat; holds local-only `pinned` and last-known `expireTimer` |
| `contacts` | uuid preferred, else number | Address-book / profile directory |
| `attachments` | `id` | LRU blob cache for viewed media; `avatar:*` entries exempt from pruning |
| `kv` | `k` | Small key/value store (e.g. cached groups map) |

## Normalized event shapes

[`normalize.js`](../app/js/normalize.js) emits these, consumed by `store.js`:

```
message      { convId, groupInternalId?, incoming, author, authorName,
               timestamp, body, styles, quote?, attachments, expiresInSeconds? }
edit         { convId, author, targetTimestamp, newBody, newStyles, timestamp }
reaction     { convId, reactor, emoji, remove, targetAuthor, targetTimestamp }
remoteDelete { convId, author, targetTimestamp }
pin / unpin  { convId, targetAuthor, targetTimestamp }
typing       { convId, author, started }
receipt      { peer, kind: 'delivery' | 'read', timestamps: [..] }
readSync     { entries: [{ sender, timestamp }] }
```

- **`pin` / `unpin`** come from group pinned-message updates (body-less
  `dataMessage`s), so `normalize.js` checks for them before the empty-dataMessage
  early-return; the store flips the target's `pinned` flag, so group pins sync
  both ways.
- **Disappearing messages** carry `expiresInSeconds`; the store records an
  absolute `expiresAt`, and a periodic sweep (`db.deleteExpired`, also on chat
  open) removes messages past it and emits `message-removed`.
- **Synced sends** from your other linked devices arrive as `syncMessage`
  envelopes, normalized into the same `message` / `edit` events with
  `incoming: false`. A `syncMessage.readMessages` becomes a `readSync` that
  clears the matching conversation's unread badge.
- **`styles`** is an array of `{ start, length, style }` ranges (`BOLD`,
  `ITALIC`, `STRIKETHROUGH`, `MONOSPACE`, `SPOILER`). On receive they're parsed
  from signal-cli `textStyles` with offsets remapped to the mention-substituted
  body; on send, `App.util.parseStyledMarkdown` builds the same shape for the
  local echo while the server does the real conversion (`text_mode: styled`).
  Rendering is shared in `App.util.renderStyledBody`.

## Conversation and message records

A stored **message**:

```js
{
  id, convId, incoming, author, authorName, timestamp,
  body, styles, quote, attachments,
  raw,                       // outgoing only: text as typed (with markers)
  reactions,                 // { reactorKey: emoji }
  status,                    // pending | sent | delivered | read | received | failed
  deleted, edited,
  pinned?,                   // group message pin (synced)
  expireSecs?, expiresAt?    // disappearing-message timer + absolute deadline
}
```

Delivery status only moves forward, ranked
`pending/failed < sent < delivered < read`, so an out-of-order receipt can't
downgrade a message.

A **conversation**:

```js
{
  id, type,                  // 'direct' | 'group'
  sendId,                    // recipient/group id used when sending
  groupInternalId?,          // groups only
  name, lastTs, lastPreview,
  unread, lastReadTs,
  archived?, muted?, pinned?, // local-only flags (not synced from Signal)
  expireTimer?               // last-known disappearing-message interval (seconds)
}
```
