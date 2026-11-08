# AGENTS.md

Instructions for AI agents working in this repository. Read this before making any change. The full developer reference is [`docs/development.md`](docs/development.md); user setup is [`docs/setup.md`](docs/setup.md).

## What this is

**signal4kaios** (v2.0.0+) is a standalone Signal client for **KaiOS 3.0, 3.1, and 4.0** feature phones. Support for KaiOS 2.5, the self-hosted gateway, and `signal-cli-rest-api` has been removed. All Signal Protocol cryptography (XEdDSA, X3DH, Double Ratchet, Sealed Sender, Sender Keys, Attachment crypto, Safety Numbers, and Linked Device QR provisioning) runs directly on the phone.

The app is packaged as a **privileged** KaiOS 3.0+ app ([`app/manifest.webmanifest`](app/manifest.webmanifest)) and distributed as a ZIP on GitHub Releases, installed via OStore's Manual Install or sideloaded with `appscmd`.

## Build & platform constraints

- **Target engine:** KaiOS 3.0 / 3.1 (Gecko 84) and KaiOS 4.0 (Gecko 123), supporting ES2020 and WebCrypto (`crypto.subtle`).
- **Privileged CSP:** No inline event handlers, no inline `<script>` or `<style>`, and no `eval()` / `new Function()`.
- **On-device Signal engine (`src/engine/`):** Written in TypeScript using `@noble/curves` and `@noble/hashes` plus a zero-`eval` protobuf wire codec ([`src/engine/proto.ts`](src/engine/proto.ts)), bundled by `esbuild` into `app/vendor/signal-engine.bundle.js` (`npm run build`), exposing `window.App.signal`.
- Always run `npm run typecheck && npm test && sh app/scripts/package.sh` after changes.

## Architecture at a glance

```
Signal WSS ──▶ ws.js ──▶ App.signal (src/engine/) ──▶ normalize.js ──▶ store.js ──▶ IndexedDB (db.js)
                                                                          │
                                                                          └──▶ js/screens/* patch the DOM
```

- **Provisioning:** [`screens/serversettings.js`](app/js/screens/serversettings.js) calls `App.signal.startProvisioning`, which connects to `wss://chat.signal.org/v1/websocket/provisioning/`, renders the `sgnl://linkdevice` QR code on the phone, decrypts `ProvisionMessage`, registers the linked device (`PUT /v1/devices/{code}`), uploads PreKeys (`PUT /v2/keys`), and requests contact/group sync from the primary device.
- **Receive:** [`ws.js`](app/js/ws.js) connects to `wss://chat.signal.org/v1/websocket/`, passes binary `Envelope` frames to `App.signal.processIncomingEnvelope`, feeds normalized frames to [`normalize.js`](app/js/normalize.js) → [`store.js`](app/js/store.js) → [`db.js`](app/js/db.js), and ACKs the frame to Signal's server only after decryption and persistence complete.
- **Send:** Screens call `App.store.send*` → [`api.js`](app/js/api.js) → `App.signal` → [`http.js`](app/js/http.js) (`mozSystem` XHR directly to `https://chat.signal.org` and `https://cdn.signal.org`).

## Conventions

- **No hard line wrapping in prose**: don't break Markdown paragraphs, list items, or code comments at 80 columns. Write each paragraph, list item, or comment sentence as one line and let the editor soft-wrap it.
- **UI module shape**: files in `app/js/` are IIFEs attaching their public surface to `window.App`, loaded in the order listed in [`app/index.html`](app/index.html).
- **DOM**: build nodes with `App.util.el(tag, className, text)`; never use `innerHTML` with untrusted content.
- **Diagnostics**: log to the in-app ring buffer with `App.util.dbg(msg, data)` (Settings → Debug log). Use `App.toast(msg)` for user-facing notices.
- **KaiOS B2G APIs**: go through [`platform.js`](app/js/platform.js) (`App.platform`).

## Definition of done

- `npm run typecheck` passes with no errors.
- `npm test` passes all unit tests.
- `sh app/scripts/package.sh` builds `app/vendor/signal-engine.bundle.js` and produces `dist/signal4kaios.zip` and `dist/signal4kaios-2.0.0.zip`.

## Security baseline

The enterprise product-security rules apply: no hardcoded secrets, treat all external input (WebSocket frames, protobuf payloads, API responses) as untrusted, and never log private keys, signaling passwords, or credentials via `App.util.dbg` or console output.
