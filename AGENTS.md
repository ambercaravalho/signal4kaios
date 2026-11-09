# AGENTS.md

Instructions for AI agents working in this repository. Read this before making any change. The full developer reference is [`docs/development.md`](docs/development.md); user setup is [`docs/setup.md`](docs/setup.md).

## What this is

**signal4kaios** (v2.0.0+) is a standalone Signal client for **KaiOS 3.0, 3.1, and 4.0** feature phones. Support for KaiOS 2.5, the self-hosted gateway, and `signal-cli-rest-api` has been removed. All Signal cryptography runs directly on the phone, using Signal's official libsignal compiled to WebAssembly (PQXDH, Double Ratchet, Sealed Sender, Sender Keys, Safety Numbers, provisioning, zkgroup, usernames). Never reimplement these in TypeScript.

The app is packaged as a **privileged** KaiOS 3.0+ app ([`app/manifest.webmanifest`](app/manifest.webmanifest)) and distributed as a ZIP on GitHub Releases, installed via OStore's Manual Install or sideloaded with `appscmd`.

## Build & platform constraints

- **Target engine:** KaiOS 3.0 / 3.1 (Gecko 84) and KaiOS 4.0 (Gecko 123), supporting ES2020 and WebCrypto (`crypto.subtle`).
- **Privileged CSP:** No inline event handlers, no inline `<script>` or `<style>`, and no `eval()` / `new Function()`. WebAssembly is allowed on KaiOS 3.x; KaiOS 4.0 needs the rooted `'wasm-unsafe-eval'` step in [`docs/setup.md`](docs/setup.md#kaios-40-enable-webassembly).
- **libsignal wrapper (`native/libsignal-wasm/`):** A wasm-bindgen Rust crate over official libsignal crates pinned to one release commit, with a record-in/record-out API. Building it needs rustup (toolchain from `rust-toolchain.toml`), `protoc`, and `wasm-bindgen-cli` at the exact version pinned in `Cargo.toml` (`npm run build:wasm`, output `app/vendor/libsignal_wasm_bg.wasm`). The crate is AGPL-3.0-only.
- **On-device Signal engine (`src/engine/`):** TypeScript that drives the wrapper through [`src/engine/protocol.ts`](src/engine/protocol.ts), with `@noble/hashes` and WebCrypto for the TypeScript-only paths and `@bufbuild/protobuf` codecs generated from vendored Signal `.proto` files into `src/engine/gen/` (`npm run gen:protos`; never hand-edit `gen/`). Bundled by `esbuild` into `app/vendor/signal-engine.bundle.js` (`npm run build`), exposing `window.App.signal`.
- Always run `npm run build:wasm && npm run typecheck && npm test && sh app/scripts/package.sh` after changes.

## Architecture at a glance

```
Signal WSS ──▶ ws.js ──▶ App.signal (src/engine/ + libsignal wasm) ──▶ normalize.js ──▶ store.js ──▶ IndexedDB (db.js)
                                                                          │
                                                                          └──▶ js/screens/* patch the DOM
```

- **Provisioning:** [`screens/serversettings.js`](app/js/screens/serversettings.js) calls `App.signal.startProvisioning`, which connects to `wss://chat.signal.org/v1/websocket/provisioning/`, renders the `sgnl://linkdevice` QR code on the phone, decrypts `ProvisionMessage`, registers the linked device with its PreKeys (`PUT /v1/devices/link`), and requests contacts, blocked list, configuration, and keys from the primary device; contacts and groups then come from Storage Service and the Groups V2 server.
- **Receive:** [`ws.js`](app/js/ws.js) connects to `wss://chat.signal.org/v1/websocket/`, passes binary `Envelope` frames to `App.signal.processIncomingEnvelope`, feeds normalized frames to [`normalize.js`](app/js/normalize.js) → [`store.js`](app/js/store.js) → [`db.js`](app/js/db.js), and ACKs the frame to Signal's server only after decryption and persistence complete.
- **Send:** Screens call `App.store.send*` → [`api.js`](app/js/api.js) → `App.signal` → [`http.js`](app/js/http.js) (`mozSystem` XHR directly to `https://chat.signal.org` and `https://cdn.signal.org`).

## Conventions

- **No hard line wrapping in prose**: don't break Markdown paragraphs, list items, or code comments at 80 columns. Write each paragraph, list item, or comment sentence as one line and let the editor soft-wrap it.
- **UI module shape**: files in `app/js/` are IIFEs attaching their public surface to `window.App`, loaded in the order listed in [`app/index.html`](app/index.html).
- **DOM**: build nodes with `App.util.el(tag, className, text)`; never use `innerHTML` with untrusted content.
- **Diagnostics**: log to the in-app ring buffer with `App.util.dbg(msg, data)` (Settings → Debug log). Use `App.toast(msg)` for user-facing notices.
- **KaiOS B2G APIs**: go through [`platform.js`](app/js/platform.js) (`App.platform`).

## Definition of done

- `npm run build:wasm` builds the libsignal wrapper (CI also checks that `npm run gen:protos` leaves `src/engine/gen/` unchanged).
- `npm run typecheck` passes with no errors.
- `npm test` passes all unit, interop (against `@signalapp/libsignal-client`), and known-answer tests.
- `sh app/scripts/package.sh` builds the wasm module and `app/vendor/signal-engine.bundle.js`, passes its `eval` check, and produces `dist/signal4kaios.zip` and `dist/signal4kaios-2.0.0.zip`.

## Security baseline

The enterprise product-security rules apply: no hardcoded secrets, treat all external input (WebSocket frames, protobuf payloads, API responses) as untrusted, and never log private keys, signaling passwords, or credentials via `App.util.dbg` or console output.
