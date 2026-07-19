# Development

How to work on the app safely. Pairs with [Architecture](architecture.md) (how
it's built) and [AGENTS.md](../AGENTS.md) (the condensed rules).

- [Ground rules](#ground-rules)
- [Gecko 48 constraints](#gecko-48-constraints)
- [Packaging](#packaging)
- [Developing on the desktop](#developing-on-the-desktop)
- [Testing on KaiOS](#testing-on-kaios)
- [Code conventions](#code-conventions)
- [Adding a screen](#adding-a-screen)
- [Debugging](#debugging)

## Ground rules

- **The KaiOS app (`app/`) has no build step, no bundler, no package manager, no
  dependencies.** Files under [`app/`](../app) are served as-is. Don't add npm,
  transpilers, or a framework to the app.
- The app is **privileged**; its CSP forbids inline scripts, styles, and event
  handlers.
- Target runtime is **KaiOS 2.5 = Gecko 48** (ES5-era). The app **also** runs on
  **KaiOS 3.0/3.1** (Gecko 84) and **4.0** (Gecko 123), so keep first-party page
  code (`app/js`) ES5-clean — 2.5 is the lowest common denominator. See
  [Cross-version support](#cross-version-support).
- The **[gateway](gateway.md)** is a **separate** Node/TypeScript component
  ([`gateway/`](../gateway)) that runs server-side. It has its own `package.json`
  + `tsc` build and normal npm dependencies; **the Gecko-48 constraints and the
  "no build step" rule above do NOT apply to it.** The packaging gate only scans
  `app/`, so the gateway is out of scope for it.

## Gecko 48 constraints

These run fine in a modern desktop browser but **break on the phone**.
[`app/scripts/package.sh`](../app/scripts/package.sh) hard-fails packaging on the
first four:

| Banned | Use instead |
|---|---|
| `async` / `await` | Promises with `.then()` / `.catch()` |
| Spread / rest `...` | `Object.assign`, `Function.prototype.apply`, manual copies |
| `String.padStart` / `padEnd` | Manual padding (see `util.pad2`) |
| CSS `display: grid` | Flexbox |
| ES modules (`import` / `export`) | Plain scripts on the `App` global |
| Arrow functions, template literals, `let` / `const`, classes | `var`, `function`, string concatenation |
| Inline `onclick=` / `<script>` / `<style>` | `addEventListener`, external `.js` / `.css` |

Passing the syntax gate clears the automated checks, but not the runtime-only
bans (ES modules and below) — you must uphold those yourself.

## Cross-version support

The app targets KaiOS 2.5, 3.0, 3.1, and 4.0 from one codebase. 3.0 and 3.1
share the same engine and app model, so they behave identically here. The
differences that matter:

| Concern | KaiOS 2.5 | KaiOS 3.0 / 3.1 / 4.0 |
|---|---|---|
| Engine | Gecko 48 (ES5) | Gecko 84 (3.0/3.1) / 123 (4.0), ES2021 |
| Manifest | [`manifest.webapp`](../app/manifest.webapp) | [`manifest.webmanifest`](../app/manifest.webmanifest) (keys under `b2g_features`) |
| Origin | `app://…` | `http://signal4kaios.localhost` |
| Web activities | `MozActivity` | `WebActivity` |
| Device storage | `navigator.getDeviceStorage` | `navigator.b2g.getDeviceStorage` |
| Alarms | `navigator.mozAlarms` + `mozSetMessageHandler` | `navigator.b2g.alarmManager` + ServiceWorker `systemmessage` |
| ServiceWorker | none | yes ([`app/sw.js`](../app/sw.js)) |

Both manifests ship in the same package — the OS reads whichever it understands.
`systemXHR` + `mozSystem` XHR, `WebSocket`, IndexedDB, and `getUserMedia` work
unchanged on both.

**Rule: never call a version-specific B2G API directly.** Route it through
[`platform.js`](../app/js/platform.js) (`App.platform`), which feature-detects
the 3.0+ shape first and falls back to the 2.5 shape, always returning a
Promise. Current helpers: `openActivity`, `getDeviceStorage` + `addNamed`,
`scheduleAlarm`, `hasServiceWorker`. The ServiceWorker
([`sw.js`](../app/sw.js)) is 3.0+-only (registered from
[`main.js`](../app/js/main.js) behind `App.platform.hasServiceWorker()`) and
relays the `alarm` system message and notification clicks back to the page.

## Packaging

```sh
sh app/scripts/package.sh
```

Runs the Gecko-48 syntax gate against `app/js` and `app/css`, then zips `app/`
into `dist/signal4kaios.zip` (`dist/` is gitignored; `app/scripts/` is excluded
from the zip). The gate scans **only** first-party code; vendor a third-party
library in [`app/vendor/`](../app/vendor) to keep prebuilt files (e.g. the `jsQR`
decoder) out of the gate — they're still zipped and loaded via `<script>`. Keep
your own code in `app/js` so it stays gated.

Install/sideload steps are in
[Getting started → Install](getting-started.md#2-install-sideload). Re-sideload
after any change to manifest permissions (`manifest.webapp` on 2.5,
`manifest.webmanifest` on 3.0+).

## Developing on the desktop

[`http.js`](../app/js/http.js) falls back to a plain XHR when `mozSystem` isn't
available, so you can iterate in a normal browser behind a CORS proxy. Run the
[gateway](gateway.md) first (it's what the app talks to), then:

```sh
# serve the app
cd app && python3 -m http.server 8000

# proxy the gateway's HTTP API to add CORS headers (the WebSocket relay is not
# subject to CORS and connects to the gateway directly)
npx local-cors-proxy --proxyUrl http://192.168.1.100:8090 --port 8091
```

Then set the in-app **Server URL** to the proxy (e.g. `http://localhost:8091`).
The gateway itself only adds CORS to `/v1/push/*`, so a CORS proxy is still needed
for the proxied API when developing in a desktop browser.

**Caveat:** the desktop doesn't enforce the privileged-app CSP, so inline
handlers/styles that would be rejected on the phone appear to work. Keep all
scripts and styles in local files and verify on-device or in the simulator.

## Developing the gateway

The gateway lives in [`gateway/`](../gateway) and is an ordinary Node project:

```sh
cd gateway
npm install
npm run build          # type-check + compile to dist/
SIGNAL_CLI_URL=http://127.0.0.1:8080 npm start
```

See the [Gateway docs](gateway.md) for the env vars, the WS envelope/cursor
protocol, and push behavior. For a container setup, use
[`docker/docker-compose.yml`](../docker/docker-compose.yml).

## Testing on KaiOS

Verify in the **KaiOS 2.5 simulator** (kaiosrt via WebIDE) or on a real device
before trusting a change. The simulator enforces the CSP and runs the real Gecko
48 engine, catching syntax and permission issues the desktop misses.

For **KaiOS 3.0/3.1/4.0**, WebIDE is gone. Install with `appscmd` over an
adb-forwarded debugger socket (see
[`app/scripts/install-kaios3plus.sh`](../app/scripts/install-kaios3plus.sh) and
[Getting started → Install](getting-started.md#on-kaios-30-31-and-40)) and debug
with a modern Firefox at `about:debugging`. Because the 3.0+ engine is much
newer, run a quick regression on a 2.5 device/simulator too — a change that works
on 4.0 can still break the Gecko-48 path.

## Code conventions

- **Module shape**: `(function () { 'use strict'; /* ... */ App.foo = {...}; })();`
  — one IIFE per file, public surface on `App`.
- Reach other modules only through `App.*`; don't create other globals.
- Build DOM with `App.util.el(tag, className, text)`; avoid `innerHTML` for
  anything with remote content.
- Use `App.util.dbg(msg, data)` for diagnostics (no console on the phone) and
  `App.toast(msg)` for user-facing notices.
- Put **all** envelope parsing in [`normalize.js`](../app/js/normalize.js), and
  never let an unrecognized shape throw — log it and move on.
- Route message read-modify-write updates through `enqueueMutation` in
  [`store.js`](../app/js/store.js).
- Add boolean feature flags to [`config.js`](../app/js/config.js) following the
  `sendReadReceipts` pattern (accessor with a sensible default), then gate on
  `App.config.<flag>()`.
- Reach version-specific KaiOS APIs (activities, device storage, alarms) only
  through [`App.platform`](../app/js/platform.js) — never call `MozActivity`,
  `navigator.getDeviceStorage`, or `navigator.mozAlarms` directly.
- Register every new `js/` file in [`app/index.html`](../app/index.html) at the
  correct load-order position.

## Adding a screen

1. Create `app/js/screens/<name>.js` as an IIFE defining
   `App.screens.<name> = { create: function (args) { ... } };`.
2. Have `create()` return an object matching the screen contract:

   ```js
   {
     el,                      // root element (class 'screen')
     enter: function () {},   // first shown: subscribe, set softkeys, render
     resume: function () {},  // shown again after a child pops
     pause: function () {},   // a child screen is covering this one
     destroy: function () {}, // popped: unsubscribe, revoke object URLs
     onKey: function (evt) { return handled; } // true if you consumed the key
   }
   ```

3. Use an [`App.Nav`](../app/js/nav.js) instance for D-pad selection: mark nodes
   `nav-selectable`, give them a `data-id`, and let `Nav` manage `nav-selected`
   and scrolling.
4. Set softkeys with `App.softkeys.set(left, center, right)`.
5. Push/pop/replace via `App.router`. Return `true` from `onKey` for keys you
   handle; leave `Backspace` unhandled to let the router pop.
6. Add `<script src="js/screens/<name>.js"></script>` to
   [`index.html`](../app/index.html) (after `menu.js`, before `main.js`).

[`screens/menu.js`](../app/js/screens/menu.js) is the smallest complete example;
[`screens/conversations.js`](../app/js/screens/conversations.js) shows store
subscriptions and the pause/resume re-render pattern.

## Debugging

- **Settings → Debug log** shows the in-app ring buffer (`App.util.dbg` output):
  unhandled envelope shapes, network errors, WebSocket lifecycle.
- On desktop or in the simulator you also have the normal devtools / WebIDE
  console.
- Never log credentials (proxy auth) to the debug buffer.
