# AGENTS.md

Instructions for AI agents working in this repository. Read this before making
any change. Deeper documentation lives in [`docs/`](docs/README.md).

## What this is

**signal4kaios** is a Signal messenger client for **KaiOS 2.5** feature phones.
It talks to a self-hosted
[signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) server
(in `json-rpc` mode) over HTTP + a receive WebSocket. It is packaged as a
**privileged** KaiOS app and sideloaded onto the phone.

There is **no build step, no bundler, no package manager, no dependencies, and
no `package.json`**. The app is plain files under [`app/`](app/) served as-is.
Do not introduce npm, transpilers, frameworks, or a build pipeline.

## Non-negotiable platform constraints

KaiOS 2.5 runs **Gecko 48** (roughly Firefox 48, ES5-era). Code that uses newer
syntax will silently break on the phone even though it runs fine on your desktop.
[`tools/package.sh`](tools/package.sh) hard-fails packaging if it detects any of
these, so treat them as bans:

- No `async` / `await`. Use Promises with `.then()` / `.catch()`.
- No spread / rest `...` (in any position). Use `Object.assign`, `.apply`, etc.
- No `String.prototype.padStart` / `padEnd` (unreliable on Gecko 48).
- No CSS `display: grid`. Use flexbox.

Additional bans that the grep gate does **not** catch but that will break the
privileged-app CSP or the runtime — you must uphold these manually:

- No ES modules (`import` / `export`). Every file is a plain script.
- No arrow functions, template literals, `let`/`const`, classes, generators, or
  other post-ES5 syntax. Use `var` and `function`.
- No inline event handlers (`onclick="..."`) and no inline `<script>` / `<style>`
  blocks. The privileged CSP forbids them. Keep all JS and CSS in local files.
- Bind events in JS with `addEventListener`.

When in doubt, run `sh tools/package.sh` — if it passes the syntax gate you are
clear on the automated checks.

The gate scans only first-party code (`app/js`, `app/css`). Vendored third-party
libraries live in `app/vendor/` (outside the gate) — that's where a prebuilt
file that can't meet the style rules (e.g. the `jsQR` QR decoder) belongs. Keep
your own code in `app/js` so it stays gated; don't move first-party code into
`vendor/` to dodge the checks.

## Architecture at a glance

```
ws.js ──▶ normalize.js ──▶ store.js ──▶ IndexedDB (db.js)
(receive)  (frame→events)     │
                              └──▶ emits events ──▶ js/screens/* patch the DOM
```

- Receive path: [`ws.js`](app/js/ws.js) gets raw frames →
  [`normalize.js`](app/js/normalize.js) turns them into typed events →
  [`store.js`](app/js/store.js) applies them, persists via
  [`db.js`](app/js/db.js), and emits events → screens re-render.
- Send path: screens call `App.store.send*` → optimistic record →
  [`api.js`](app/js/api.js) → [`http.js`](app/js/http.js) (mozSystem XHR).

See [`docs/architecture.md`](docs/architecture.md) for the full module reference,
IndexedDB schema, and event shapes.

## Conventions

- **Module shape**: every file is an IIFE (`(function () { 'use strict'; ... })();`)
  that attaches its public surface to the global `App` object (e.g. `App.store`,
  `App.util`). `App` is created in [`polyfills.js`](app/js/polyfills.js).
- **No implicit globals**: only reach other modules through `App.*`.
- **Load order is manual**: scripts are listed in
  [`app/index.html`](app/index.html) and load in order. A module must appear
  after everything it uses at load time. When you add a new `js/` file (including
  a new screen), add a `<script>` tag in the right place in `index.html`.
- **DOM**: build nodes with `App.util.el(tag, className, text)`; do not use
  `innerHTML` with untrusted content.
- **Diagnostics**: log to the in-app debug ring buffer with
  `App.util.dbg(msg, data)` (viewable in Settings → Debug log). This is the
  primary debugging tool since there is no console on the phone.
- **User-facing messages**: use `App.toast(msg)` for transient notices.
- **Time / formatting helpers** live in [`util.js`](app/js/util.js)
  (`fmtTime`, `initials`, `colorClass`, `debounce`, ...).
- **Config** (server URL, number, proxy auth) is in `localStorage` via
  [`config.js`](app/js/config.js). All persisted message/contact data is in
  IndexedDB via [`db.js`](app/js/db.js).

## Rules for specific areas

- **Envelope parsing belongs only in `normalize.js`.** signal-cli envelope
  shapes vary across versions, so all parsing is centralized there. Unknown or
  unexpected shapes must be logged with `App.util.dbg` and skipped — **never let
  a malformed frame throw or crash the app.**
- **Message mutations must be serialized.** Read-modify-write updates to stored
  messages (reactions, receipts, edits, deletes) go through `enqueueMutation` in
  [`store.js`](app/js/store.js) so concurrent frames can't clobber each other.
  Follow that pattern for any new message mutation.
- **IndexedDB is the only message history.** The REST API has no history
  endpoint; history accrues from first use and is pruned to ~500 messages per
  conversation. Don't assume the server can backfill.
- **WebSocket + Basic Auth is unfixable in the app.** A browser `WebSocket`
  cannot carry Basic Auth credentials on its handshake. Do not attempt an
  in-app workaround; the fix is proxy-side (see
  [`docs/remote-access.md`](docs/remote-access.md)).

## Adding a screen

Screens are objects returned by a `create()` factory, registered on
`App.screens.<name>`, and driven by the router
([`router.js`](app/js/router.js)). The contract:

```js
{ el, enter(), resume(), pause(), destroy(), onKey(evt) /* -> true if handled */ }
```

- D-pad navigation: mark focusable nodes with the `nav-selectable` attribute and
  use an `App.Nav` instance ([`nav.js`](app/js/nav.js)); it manages the
  `nav-selected` state and scrolling.
- Softkey labels: set them with `App.softkeys.set(left, center, right)`
  ([`softkeys.js`](app/js/softkeys.js)).
- `onKey` returns `true` when it handles a key; unhandled `Backspace` pops the
  screen stack (KaiOS's Back key sends Backspace).
- The simplest reference is [`screens/menu.js`](app/js/screens/menu.js).
- Remember to add the new file's `<script>` tag to `index.html`.

## Definition of done

- Run `sh tools/package.sh`. It gates on Gecko-48 syntax and produces
  `dist/signal4kaios.zip`. Packaging must pass.
- Prefer verifying behavior in the KaiOS 2.5 simulator (kaiosrt via WebIDE)
  before trusting a change; a desktop browser does not enforce the privileged CSP
  and `http.js` falls back to a plain XHR there (use a CORS proxy — see
  [`docs/development.md`](docs/development.md)).
- Re-sideload after any change to `manifest.webapp` permissions.

## Security baseline

The workspace enterprise product-security rules still apply: no hardcoded
secrets, treat all external input (including WebSocket frames and API responses)
as untrusted, and never log credentials. Proxy auth credentials live in config
and must never be logged via `App.util.dbg`.
