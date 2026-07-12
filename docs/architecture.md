# Architecture

How the app is put together. For the rules you must follow when changing it, see
[AGENTS.md](../AGENTS.md); for tooling and conventions, see
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
public API off a global `App` object. The core data flow is one direction:

```
ws.js ──▶ normalize.js ──▶ store.js ──▶ IndexedDB (db.js)
(receive)  (frame→events)     │
                              └──▶ emits events ──▶ js/screens/* patch the DOM
```

Screens are pure consumers: they subscribe to store events and re-render. They
never parse network frames or write to IndexedDB directly for message data —
they go through `App.store`.

## The receive path

1. **[`ws.js`](../app/js/ws.js)** maintains the WebSocket to
   `ws(s)://<server>/v1/receive/<number>`, with exponential-backoff reconnect
   (plus jitter) and a reconnect-on-foreground handler. Each frame's JSON is
   parsed and handed to `App.store.ingestRaw`.
2. **[`normalize.js`](../app/js/normalize.js)** is the single choke point that
   converts a raw signal-cli envelope into zero or more **typed events**.
   Envelope shapes vary across signal-cli versions, so **all** parsing lives
   here, and anything unrecognized is logged via `App.util.dbg` and skipped —
   never thrown.
3. **[`store.js`](../app/js/store.js)** applies each event: it builds/updates
   conversation and message records, persists them via `App.db`, and emits
   high-level events (`message`, `message-updated`, `conversations`, `typing`,
   `connection`, ...) that screens listen to.

Read-modify-write updates to stored messages (reactions, receipts, edits,
deletes) run through a single serial queue (`enqueueMutation`) so concurrently
arriving frames can't clobber each other.

## The send path

Screens call `App.store.sendText` / `sendAttachment` / `sendEdit` / `reactTo` /
etc. These:

1. Write an **optimistic** record to IndexedDB (`status: 'pending'`) and emit so
   the UI shows it immediately.
2. Call the REST API via **[`api.js`](../app/js/api.js)** →
   **[`http.js`](../app/js/http.js)**.
3. On success, re-key the message to the server's returned timestamp and mark it
   `sent`; on failure mark it `failed` (retryable from the message options).

## Module reference

Load order is defined in [`app/index.html`](../app/index.html); a module must
load after everything it depends on.

| File | Responsibility |
|---|---|
| [`polyfills.js`](../app/js/polyfills.js) | Tiny Gecko-48 shims; creates `window.App` |
| [`util.js`](../app/js/util.js) | `el`, time/format helpers, `initials`, `colorClass`, `debounce`, `scaleImage`, and the `dbg` ring buffer |
| [`config.js`](../app/js/config.js) | Settings in `localStorage` (server URL, number, proxy auth); URL/WS-URL helpers |
| [`toast.js`](../app/js/toast.js) | `App.toast` transient message bar |
| [`http.js`](../app/js/http.js) | Promise wrapper over `mozSystem` XHR (CORS-free, privileged); desktop XHR fallback; attaches Basic Auth |
| [`api.js`](../app/js/api.js) | Thin wrappers over the signal-cli-rest-api endpoints |
| [`db.js`](../app/js/db.js) | IndexedDB persistence — the message history itself |
| [`normalize.js`](../app/js/normalize.js) | Envelope → typed events (the only parser) |
| [`ws.js`](../app/js/ws.js) | Receive WebSocket with backoff/reconnect; Basic-Auth failure detection |
| [`store.js`](../app/js/store.js) | State hub: apply events, persist, emit; optimistic send; serialized mutations |
| [`avatars.js`](../app/js/avatars.js) | Profile-photo fetch + cache with per-session memoization |
| [`nav.js`](../app/js/nav.js) | D-pad selection via `nav-selectable` / `nav-selected` |
| [`softkeys.js`](../app/js/softkeys.js) | Presentational SoftLeft/Center/SoftRight labels |
| [`router.js`](../app/js/router.js) | Screen stack + one global keydown dispatcher |
| [`main.js`](../app/js/main.js) | Boot: init router + store, push first screen, background prune |
| [`screens/*.js`](../app/js/screens) | Individual screens (see below) |

## Screens and the router

**[`router.js`](../app/js/router.js)** owns a screen **stack** and a single
global `keydown` listener that dispatches to the top screen. Paused screens keep
their (hidden) DOM so scroll position and selection survive back-navigation.
Unhandled `Backspace` pops the stack (KaiOS's Back key sends Backspace);
preventing default is required or the system closes the app.

A screen is an object with this contract:

```js
{ el, enter(), resume(), pause(), destroy(), onKey(evt) /* -> true if handled */ }
```

Screens live in [`app/js/screens/`](../app/js/screens): conversations, archived,
chat, newchat, msgopts (message options), reactions (picker), viewer
(attachment), search, settings, debuglog, and a generic `menu`. The simplest one
to copy is [`screens/menu.js`](../app/js/screens/menu.js). See
[Development → Adding a screen](development.md#adding-a-screen).

## IndexedDB schema

Database `signal4kaios` (version 2), defined in [`db.js`](../app/js/db.js). Since
the REST API has no history endpoint, **this database is the message history.**

| Store | Key | Notes |
|---|---|---|
| `messages` | `id` = `convId\|timestamp\|author` | Index `conv` on `[convId, timestamp]` for paging; pruned to ~500/conv |
| `conversations` | `id` (peer number/uuid, or `g:` + internal group id) | One record per chat |
| `contacts` | `id` (uuid preferred, else number) | Address-book / profile directory |
| `attachments` | `id` | LRU blob cache for viewed media; `avatar:*` entries are exempt from pruning |
| `kv` | `k` | Small key/value store (e.g. cached groups map) |

Conversation ids: direct chats use the peer's number or uuid; groups use
`g:<internal_id>`.

## Normalized event shapes

[`normalize.js`](../app/js/normalize.js) emits these event objects, consumed by
`store.js`:

```
message      { convId, groupInternalId?, incoming, author, authorName,
               timestamp, body, quote?, attachments, expiresInSeconds? }
edit         { convId, author, targetTimestamp, newBody, timestamp }
reaction     { convId, reactor, emoji, remove, targetAuthor, targetTimestamp }
remoteDelete { convId, author, targetTimestamp }
typing       { convId, author, started }
receipt      { peer, kind: 'delivery' | 'read', timestamps: [..] }
```

Messages sent from another of your linked devices arrive as `syncMessage`
envelopes and are normalized into the same `message` / `edit` events with
`incoming: false`.

## Conversation and message records

A **message** record (as stored) looks like:

```js
{
  id, convId, incoming, author, authorName, timestamp,
  body, quote, attachments,
  reactions,                 // { reactorKey: emoji }
  status,                    // pending | sent | delivered | read | received | failed
  deleted, edited
}
```

Delivery status only ever moves forward, ranked
`pending/failed < sent < delivered < read`, so an out-of-order receipt can't
downgrade a message.

A **conversation** record:

```js
{
  id, type,                  // 'direct' | 'group'
  sendId,                    // recipient/group id used when sending
  groupInternalId?,          // groups only
  name, lastTs, lastPreview,
  unread, lastReadTs,
  archived?, muted?          // local-only flags (not synced from Signal)
}
```
