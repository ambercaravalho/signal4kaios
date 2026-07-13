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

- **No build step, no bundler, no package manager, no dependencies.** Files under
  [`app/`](../app) are served as-is. Don't add npm, transpilers, or a framework.
- The app is **privileged**; its CSP forbids inline scripts, styles, and event
  handlers.
- Target runtime is **KaiOS 2.5 = Gecko 48** (ES5-era).

## Gecko 48 constraints

These run fine in a modern desktop browser but **break on the phone**.
[`tools/package.sh`](../tools/package.sh) hard-fails packaging on the first four:

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

## Packaging

```sh
sh tools/package.sh
```

Runs the Gecko-48 syntax gate against `app/js` and `app/css`, then zips `app/`
into `dist/signal4kaios.zip` (`dist/` is gitignored). The gate scans **only**
first-party code; vendor a third-party library in [`app/vendor/`](../app/vendor)
to keep prebuilt files (e.g. the `jsQR` decoder) out of the gate — they're still
zipped and loaded via `<script>`. Keep your own code in `app/js` so it stays
gated.

Install/sideload steps are in
[Getting started → Install](getting-started.md#2-install-sideload). Re-sideload
after any change to `manifest.webapp` permissions.

## Developing on the desktop

[`http.js`](../app/js/http.js) falls back to a plain XHR when `mozSystem` isn't
available, so you can iterate in a normal browser behind a CORS proxy:

```sh
# serve the app
cd app && python3 -m http.server 8000

# proxy the API to add CORS headers (the WebSocket passes through fine)
npx local-cors-proxy --proxyUrl http://192.168.1.100:4329 --port 4330
```

Then set the in-app **Server URL** to the proxy (e.g. `http://localhost:4330`).

**Caveat:** the desktop doesn't enforce the privileged-app CSP, so inline
handlers/styles that would be rejected on the phone appear to work. Keep all
scripts and styles in local files and verify on-device or in the simulator.

## Testing on KaiOS

Verify in the **KaiOS 2.5 simulator** (kaiosrt via WebIDE) or on a real device
before trusting a change. The simulator enforces the CSP and runs the real Gecko
48 engine, catching syntax and permission issues the desktop misses.

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
