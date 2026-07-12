# Roadmap

Work that is **not yet implemented** or **known to be broken**, with pointers for
how each could be fixed or built. These are ideas, not commitments. Endpoints
refer to [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api);
new work must respect the [Gecko 48 constraints](development.md#gecko-48-constraints).

See [Architecture](architecture.md) for where each piece would slot in, and
[Development → Adding a screen](development.md#adding-a-screen) for new UI.

## Known bugs

Defects observed in day-to-day use. Ordered roughly by how jarring they are.

| Bug | Notes for the fix |
|---|---|
| **Missed messages while disconnected are never synced** _(under investigation)_ | On reconnect the receive WebSocket in [`ws.js`](../app/js/ws.js) doesn't guarantee replay of anything that arrived while the app was offline. Reconnect/drain diagnostics (gap timing + per-session frame counts) are now logged there to capture on-device behavior; the next step is to confirm whether signal-cli re-delivers queued messages on a fresh json-rpc receive connection and, if not, add a resync trigger on reconnect. Related to **Reconnect hardening** and **History backfill** below. |

### Recently fixed

- **Mentions rendered as a `￼obj` box** — `normalize.js` now splices `@name` in place of the U+FFFC placeholders using the `mentions` array.
- **Long messages overflowed the screen** — `.msg-body` now wraps (`overflow-wrap`/`word-break`), and a scrollable "View full message" reader ([`msgview.js`](../app/js/screens/msgview.js)) is available from the message options for long bodies.
- **Broken image icon for groups without a photo** — `avatars.js` rejects non-image blobs and only swaps out the initials once the photo actually decodes (with an `onerror` fallback).
- **Group messages didn't always show the Signal nickname** — `chat.js` now prefers a saved contact's resolved name over the sender's profile name, and refreshes the directory for unknown authors.
- **Notifications had no icon / weren't clickable** — `notify()` sets an app `icon` and an `onclick` that focuses the app and opens the conversation via `App.openConversation`.
- **"No messages" flashed on cold start** — the store exposes an `isReady()` flag and the conversation list shows a loading placeholder until IndexedDB history has loaded.

## Planned features & enhancements

| Feature | Notes for implementation |
|---|---|
| **Toggle read receipts** | `markRead` in [`store.js`](../app/js/store.js) always calls `App.api.readReceipt`. Add a `sendReadReceipts` flag to [`config.js`](../app/js/config.js), gate the send on it, and expose a toggle in Settings. |
| **Sync read status across devices** | `syncMessage.readMessages` is currently only logged in [`normalize.js`](../app/js/normalize.js) (see the `unhandled`/logged branch). Turn it into an event that clears the unread badge / marks messages read when they're read on another linked device. |
| **View all reactions & who reacted** | `rec.reactions` is already a `reactor → emoji` map. Add a reactions-detail view (a new screen, or expand the **Info** row in [`msgopts.js`](../app/js/screens/msgopts.js)) that lists each emoji with the resolved `displayName` of who left it. |
| **Search within New chat** | [`newchat.js`](../app/js/screens/newchat.js) lists every contact/group with no filter. Add a query input that filters the list client-side (mirror the input handling in [`search.js`](../app/js/screens/search.js)). |
| **Start a chat by username or number** | Let New chat accept a typed Signal username or phone number and open a conversation via `openConversationWith`. Validate manually entered numbers with `GET /v1/search` before starting (see also below). |
| **Wider emoji support** | KaiOS 2.5 renders a decent emoji set. Expand the six-default reaction grid in [`reactions.js`](../app/js/screens/reactions.js) into a fuller picker, and add an emoji entry path for the composer. |
| **Reorganize Settings into sections** | [`settings.js`](../app/js/screens/settings.js) is a flat list. Group fields/actions under headers (e.g. Server / Notifications / Data) for scannability. |
| **Pinned messages** | Render and sync Signal's pinned messages. Blocked on signal-cli-rest-api exposing a pin endpoint — confirm API support before building; otherwise this is unsupported. |
| **Notifications while the app is killed** | Notifications stop once the app is cleared from RAM because the receive WebSocket only runs while the app is alive. Needs a background wake mechanism (`alarms` permission) or system push; may not be fully solvable on KaiOS without push. Tied to **Reconnect hardening**. |
| **Group info & management** | Show members/description (`GET /v1/groups/{number}/{groupid}`); create / update / leave. |
| **Safety numbers** | List & verify via `/v1/identities/{number}`. |
| **Profile editing** | Set own name/avatar via `PUT /v1/profiles/{number}`. |
| **Polls** | Render incoming polls; create/vote via `/v1/polls/{number}`. |
| **Sticker packs** | Render incoming stickers; manage via `/v1/sticker-packs/{number}`. |
| **Registered-number check** | `GET /v1/search` to validate manually entered numbers in New chat (supports "start a chat by username or number" above). |
| **Contact management** | Rename via `PUT /v1/contacts/{number}` + `/sync`. |
| **Jump-to-message from search** | Pass a target timestamp to the chat screen and page until reached. |
| **History backfill** | No REST API for history — would need a companion export/import script on the server. Also relevant to syncing missed messages. |
| **Multi-account** | Per-account IndexedDB database + account switcher in Settings. |
| **Reconnect hardening** | `alarms` permission to wake the app and reconnect the WebSocket; enables catching up on missed messages and notifications after the app has been suspended. |
