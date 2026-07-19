# AGENTS.md

Instructions for AI agents working in this repository. Read this before making
any change. Deeper docs live in [`docs/`](docs/README.md).

## What this is

**signal4kaios** is a Signal client for **KaiOS 2.5** feature phones that also
runs on **KaiOS 3.0, 3.1, and 4.0**. It talks to a self-hosted
[signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) server
(in `json-rpc` mode) over HTTP + a receive WebSocket, packaged as a
**privileged** KaiOS app and sideloaded onto the phone. One package ships both
manifests ([`manifest.webapp`](app/manifest.webapp) for 2.5,
[`manifest.webmanifest`](app/manifest.webmanifest) for 3.0+); the OS reads
whichever it understands.

There is **no build step, bundler, package manager, dependency, or
`package.json`** — the app is plain files under [`app/`](app/) served as-is.
Don't introduce npm, transpilers, frameworks, or a build pipeline.

## Non-negotiable platform constraints

KaiOS 2.5 runs **Gecko 48** (~Firefox 48, ES5-era). The app also targets KaiOS
3.0/3.1 (Gecko 84) and 4.0 (Gecko 123), but 2.5 is the lowest common
denominator, so **all first-party page code (`app/js`) must stay ES5-clean**.
Newer syntax breaks
silently on the phone even though it runs on your desktop.
[`tools/package.sh`](tools/package.sh) hard-fails packaging on these four, so
treat them as bans:

- No `async` / `await` — use Promises with `.then()` / `.catch()`.
- No spread / rest `...` (anywhere) — use `Object.assign`, `.apply`, etc.
- No `String.prototype.padStart` / `padEnd` (unreliable on Gecko 48).
- No CSS `display: grid` — use flexbox.

These the gate does **not** catch but you must still uphold:

- No ES modules (`import` / `export`) — every file is a plain script.
- No arrow functions, template literals, `let`/`const`, classes, or generators —
  use `var` and `function`.
- No inline event handlers or inline `<script>` / `<style>` (the privileged CSP
  forbids them). Keep JS/CSS in local files; bind events with `addEventListener`.

When in doubt, run `sh tools/package.sh`. The gate scans only first-party code
(`app/js`, `app/css`); vendored third-party libraries go in `app/vendor/`
(outside the gate). Don't move first-party code into `vendor/` to dodge checks.

## Architecture at a glance

```
ws.js ──▶ normalize.js ──▶ store.js ──▶ IndexedDB (db.js)
(receive)  (frame→events)     │
                              └──▶ emits events ──▶ js/screens/* patch the DOM
```

- Receive: [`ws.js`](app/js/ws.js) → [`normalize.js`](app/js/normalize.js)
  (typed events) → [`store.js`](app/js/store.js) (apply, persist via
  [`db.js`](app/js/db.js), emit) → screens re-render.
- Send: screens call `App.store.send*` → optimistic record →
  [`api.js`](app/js/api.js) → [`http.js`](app/js/http.js) (mozSystem XHR).

See [`docs/architecture.md`](docs/architecture.md) for the module reference,
IndexedDB schema, and event shapes.

## Conventions

- **Module shape**: every file is an IIFE (`(function () { 'use strict'; ... })();`)
  attaching its public surface to the global `App` (e.g. `App.store`, `App.util`),
  created in [`polyfills.js`](app/js/polyfills.js).
- **No implicit globals**: reach other modules only through `App.*`.
- **Load order is manual**: scripts load in the order listed in
  [`app/index.html`](app/index.html); a module must appear after everything it
  uses. Add a `<script>` tag for every new `js/` file.
- **DOM**: build nodes with `App.util.el(tag, className, text)`; don't use
  `innerHTML` with untrusted content.
- **Diagnostics**: log to the in-app ring buffer with `App.util.dbg(msg, data)`
  (Settings → Debug log) — the primary debugging tool, since there's no console
  on the phone. Use `App.toast(msg)` for user-facing notices.
- **Config** (server URL, number, proxy auth) is in `localStorage` via
 [`config.js`](app/js/config.js); all message/contact data is in IndexedDB via
 [`db.js`](app/js/db.js).
- **Version-specific KaiOS APIs go through [`platform.js`](app/js/platform.js)**
 (`App.platform`). Never call `MozActivity`, `navigator.getDeviceStorage`, or
 `navigator.mozAlarms` directly — `App.platform` feature-detects the 3.0+
 shape (`WebActivity`, `navigator.b2g.*`, ServiceWorker) first and falls back to
 the 2.5 shape, always returning a Promise. [`sw.js`](app/sw.js) is 3.0+-only
 (registered from [`main.js`](app/js/main.js)) and relays the `alarm` system
 message and notification clicks back to the page.

## Rules for specific areas

- **Envelope parsing belongs only in `normalize.js`.** signal-cli shapes vary
  across versions, so all parsing is centralized there. Log unknown shapes with
  `App.util.dbg` and skip them — **never let a malformed frame throw.**
- **Message mutations must be serialized.** Read-modify-write updates (reactions,
  receipts, edits, deletes) go through `enqueueMutation` in
  [`store.js`](app/js/store.js) so concurrent frames can't clobber each other.
- **IndexedDB is the only message history.** The REST API has no history
  endpoint; history accrues from first use and is pruned to ~500 messages per
  conversation. Don't assume the server can backfill.
- **WebSocket + Basic Auth is unfixable in the app.** A browser `WebSocket` can't
  carry Basic Auth on its handshake, so don't attempt an in-app workaround. The
  supported fix is the optional receive token appended to the URL query
  (`App.config.receiveToken`), validated by the proxy; otherwise exempt the path
  and protect it at the network level (see
  [`docs/remote-access.md`](docs/remote-access.md)).

## Adding a screen

Screens are objects from a `create()` factory, registered on
`App.screens.<name>` and driven by [`router.js`](app/js/router.js). Contract:

```js
{ el, enter(), resume(), pause(), destroy(), onKey(evt) /* -> true if handled */ }
```

- D-pad nav: mark focusable nodes `nav-selectable` and use an `App.Nav` instance
  ([`nav.js`](app/js/nav.js)); it manages `nav-selected` and scrolling.
- Softkeys: `App.softkeys.set(left, center, right)`
  ([`softkeys.js`](app/js/softkeys.js)).
- `onKey` returns `true` when handled; unhandled `Backspace` pops the stack
  (KaiOS's Back sends Backspace).
- Simplest reference: [`screens/menu.js`](app/js/screens/menu.js). Add the new
  file's `<script>` tag to `index.html`.

## Definition of done

- Run `sh tools/package.sh` — it must pass the Gecko-48 gate and produce
  `dist/signal4kaios.zip`.
- Prefer verifying in the KaiOS 2.5 simulator (kaiosrt via WebIDE); the desktop
  doesn't enforce the privileged CSP and `http.js` falls back to plain XHR there
  (use a CORS proxy — see [`docs/development.md`](docs/development.md)).
- Re-sideload after any `manifest.webapp` permission change.

## Security baseline

The enterprise product-security rules apply: no hardcoded secrets, treat all
external input (WebSocket frames, API responses) as untrusted, and never log
credentials. Proxy auth credentials live in config and must never be logged via
`App.util.dbg`.
