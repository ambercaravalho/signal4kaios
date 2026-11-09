# Development

Everything for working on signal4kaios v2.0.0: how the on-device Signal Protocol engine and KaiOS UI are built, tested, and packaged. [AGENTS.md](../AGENTS.md) has the condensed rules.

- [Ground rules](#ground-rules)
- [Architecture](#architecture)
- [On-device Signal engine](#on-device-signal-engine)
- [Developing and testing](#developing-and-testing)
- [Packaging and releasing](#packaging-and-releasing)
- [Licensing](#licensing)
- [Code conventions](#code-conventions)

## Ground rules

- **Target platform:** KaiOS 3.0, 3.1 (Gecko 84), and 4.0 (Gecko 123). KaiOS 2.5 (Gecko 48) support was dropped in v2.0.0.
- **No backend or gateway:** All Signal protocol cryptography, device provisioning, WebSocket framing, and CDN attachment encryption happen directly on the phone.
- **Official cryptography only:** Signal Protocol, Sealed Sender, Sender Keys, safety numbers, provisioning, zkgroup, and username hashing come from Signal's own [libsignal](https://github.com/signalapp/libsignal) Rust crates, compiled to WebAssembly in [`native/libsignal-wasm/`](../native/libsignal-wasm). Do not reimplement them in TypeScript.
- **Privileged CSP:** The app is packaged as a privileged KaiOS app (`manifest.webmanifest`); its CSP forbids inline scripts, inline styles, `eval`, and `new Function`. WebAssembly is allowed on KaiOS 3.x; KaiOS 4.0 needs the rooted [`'wasm-unsafe-eval'` step](setup.md#kaios-40-enable-webassembly).
- **Engine bundle:** The TypeScript engine in [`src/engine/`](../src/engine) plus the wasm-bindgen glue is bundled by `esbuild` into `app/vendor/signal-engine.bundle.js` (IIFE, ES2020, zero `eval`) and loaded by [`app/index.html`](../app/index.html) as `window.App.signal`. The compiled module ships next to it as `app/vendor/libsignal_wasm_bg.wasm`.

## Architecture

```
Signal WSS (/v1/websocket/)
  ──▶ ws.js ──▶ App.signal (decryptEnvelope) ──▶ normalize.js ──▶ store.js ──▶ IndexedDB (db.js)
                     │                                                 │
                     └──▶ libsignal_wasm_bg.wasm                       └──▶ js/screens/* patch the DOM
```

- **Startup:** [`main.js`](../app/js/main.js) awaits `App.signal.ready()`, which fetches and instantiates `vendor/libsignal_wasm_bg.wasm`. If WebAssembly is unavailable or blocked, [`screens/wasmerror.js`](../app/js/screens/wasmerror.js) explains why and links to the KaiOS 4.0 guide.
- **Receive:** [`ws.js`](../app/js/ws.js) connects directly to `wss://chat.signal.org/v1/websocket/`. Incoming binary `WebSocketMessage` frames for `PUT /api/v1/message` are decrypted in serial order by `App.signal.processIncomingEnvelope`, converted to normalized envelope JSON, passed through [`normalize.js`](../app/js/normalize.js) into [`store.js`](../app/js/store.js), persisted in IndexedDB ([`db.js`](../app/js/db.js)), and only then acknowledged to Signal's server.
- **Offline queue:** Signal servers buffer undelivered messages while the phone is offline and send `PUT /api/v1/queue/empty` once the initial queue has drained. `ws.js` ingests initial queued messages silently before switching to live notifications.
- **Send:** Screens call `App.store.send*`, which writes an optimistic `pending` record and calls [`api.js`](../app/js/api.js) → `App.signal.send*`. The engine encrypts the `Content` for each recipient device with libsignal (PQXDH + Double Ratchet, Sealed Sender when the recipient's profile key is known), handles `409` extra/missing and `410` stale devices, and delivers via `PUT /v1/messages/<aci>` over `mozSystem` XHR ([`http.js`](../app/js/http.js)). Groups are sent as pairwise 1:1 messages to every member.

## On-device Signal engine

### libsignal wrapper (`native/libsignal-wasm/`)

A thin wasm-bindgen crate over pinned official libsignal crates (`libsignal-protocol`, `zkgroup`, `usernames`, `libsignal-account-keys`, `libsignal-provisioning`). The API is record-in, record-out: for each operation TypeScript loads the serialized records it needs from IndexedDB into a short-lived `ProtocolStore`, calls libsignal, then persists whatever records changed. Errors are thrown as JS `Error`s whose `name` is a stable code (`UntrustedIdentity`, `DuplicatedMessage`, `InvalidSenderCertificate`, …).

| Module | Exposes |
|---|---|
| `src/store.rs` | `ProtocolStore`: in-memory libsignal stores, hydrated with `put*` and flushed with `take*` |
| `src/keys.rs` | Identity key pairs, XEdDSA signatures, registration IDs, PreKey / signed PreKey / Kyber PreKey records |
| `src/session.rs` | PreKey bundle processing, `message_encrypt` / `message_decrypt` (PQXDH, SPQR), `DecryptionErrorMessage`, `PlaintextContent` |
| `src/sealed.rs` | Sealed Sender encrypt and decrypt with SenderCertificate validation against Signal's trust roots |
| `src/group.rs` | Sender Key distribution, group encrypt and decrypt |
| `src/fingerprint.rs` | Safety numbers and scannable fingerprint comparison |
| `src/provisioning.rs` | Linked-device provisioning cipher |
| `src/account.rs` | Account Entropy Pool → master key, username hash |
| `src/zk.rs` | Profile key version, commitment, and access key; Groups V2 secret params, blob and member decryption, auth credential presentations |

### TypeScript engine (`src/engine/`)

| File | Responsibility |
|---|---|
| `libsignal.ts` | Loads the wasm module (`ready()`), and re-exports the wrapper as `libsignal` |
| `protocol.ts` | Hydrate → libsignal → flush around every wrapper call, serialized by a lock; trust policy; Sealed Sender trust roots |
| `prekeys.ts` | Signed, last-resort Kyber, and one-time PreKey generation and upload bodies |
| `proto.ts` + `gen/` | Codecs generated by `protoc-gen-es` from the vendored `.proto` files in [`protos/`](../protos), plus WebSocket and service-ID helpers |
| `provisioning.ts` | QR provisioning over `wss://chat.signal.org/v1/websocket/provisioning/`, `PUT /v1/devices/link` with Signal-Desktop's body and device-name cipher, PreKey upload |
| `transport.ts` | `SignalClient`: envelope decryption queue, retry receipts, device fanout with 409/410 handling, attachment upload (`/v4/attachments/form/upload`, TUS on CDN 3) and download (CDN 0/2/3), contact sync blob parsing |
| `storage.ts` | `SignalProtocolStore` with `MemorySignalStore` (tests) and `IndexedDbSignalStore` (serialized libsignal records in `App.db` v4) |
| `storage-service.ts` | Read-only Storage Service sync from `storage.signal.org` (Signal-Desktop key derivation including `recordIkm`) |
| `profiles.ts` | Versioned profile fetch and decrypt, `PUT /v1/profile` with zkgroup version and commitment, avatar decrypt, username lookup |
| `groups-v2.ts` | zkgroup group IDs and `GroupContextV2`; group state from `storage.signal.org/v2/groups/` with an auth credential presentation |
| `crypto/attachment.ts`, `crypto/primitives.ts` | WebCrypto AES and `@noble/hashes` HMAC/HKDF for the TypeScript-only paths (attachments, profiles, storage, device names), and Signal message padding |
| `index.ts` | The `App.signal` bridge for `app/js/*` |

## Developing and testing

Prerequisites: Node 20+, [rustup](https://rustup.rs) (the toolchain in [`rust-toolchain.toml`](../native/libsignal-wasm/rust-toolchain.toml) and the `wasm32-unknown-unknown` target install automatically), `protoc` (`brew install protobuf` or `apt install protobuf-compiler`; libsignal's build scripts need it), and the wasm-bindgen CLI at the exact version pinned in [`Cargo.toml`](../native/libsignal-wasm/Cargo.toml). `wasm-opt` from Binaryen is optional and shrinks the module.

```sh
cargo install wasm-bindgen-cli --version 0.2.126 --locked   # run outside native/libsignal-wasm
npm install
npm run build:wasm  # native/libsignal-wasm -> native/libsignal-wasm/pkg + app/vendor/libsignal_wasm_bg.wasm
npm run typecheck
npm test            # unit tests, interop tests against @signalapp/libsignal-client, known-answer vectors
npm run build       # bundle src/engine/index.ts -> app/vendor/signal-engine.bundle.js
```

`npm run build:wasm` must run before `typecheck` and `test`: TypeScript imports the generated glue and typings from `native/libsignal-wasm/pkg/`, and the tests load the compiled `.wasm`.

The interop tests ([`src/engine/interop.test.ts`](../src/engine/interop.test.ts)) exchange sessions, Sealed Sender messages, and Sender Key messages in both directions between our wasm build and Signal's official Node library `@signalapp/libsignal-client` (a devDependency pinned to the same libsignal release, never bundled), and compare safety numbers, username hashes, zkgroup values, Kyber records, and provisioning envelopes. The official library ships prebuilt binaries for Linux, macOS, and Windows on x64 and arm64.

Install on a KaiOS 3.0, 3.1, or 4.0 device with [`install-kaios3plus.sh`](../app/scripts/install-kaios3plus.sh) or via OStore's Manual Install tab, and inspect in Firefox `about:debugging`. **Settings → Debug log** is the primary on-device diagnostic tool.

### Bumping the libsignal pin

1. Pick a libsignal release tag and its commit, and replace the `rev` on every libsignal crate in [`Cargo.toml`](../native/libsignal-wasm/Cargo.toml). All crates must use the same commit.
2. Match the toolchain to libsignal's `rust-toolchain` file in [`rust-toolchain.toml`](../native/libsignal-wasm/rust-toolchain.toml), and the `wasm-bindgen` version if libsignal's lockfile moved.
3. Run `cargo update` in `native/libsignal-wasm`, fix any wrapper compile errors (the Rust API is not stable across releases), and commit `Cargo.lock`.
4. Set `@signalapp/libsignal-client` in `package.json` to the same version, and update the version asserted in [`protocol.test.ts`](../src/engine/protocol.test.ts).
5. Update the pin in [`buf.yaml`](../buf.yaml) if `chat_websocket.proto` changed, then run the full definition of done.

### Regenerating protobuf codecs

The `.proto` files in [`protos/`](../protos) are vendored unmodified: `protos/signal-desktop/` from Signal-Desktop and `protos/libsignal/` from libsignal, at the tags recorded in [`buf.yaml`](../buf.yaml). To update, copy the same files from the new tags, update the tags in `buf.yaml`, and run `npm run gen:protos`, which rewrites `src/engine/gen/` (committed). CI fails if the committed codecs differ from a fresh generation.

## Packaging and releasing

```sh
sh app/scripts/package.sh   # SKIP_WASM_BUILD=1 reuses the output of an earlier npm run build:wasm
```

Builds the wasm module and `app/vendor/signal-engine.bundle.js`, fails if any shipped script contains `eval(` or `new Function(`, verifies `app/manifest.webmanifest` and `app/sw.js`, adds `LICENSE` and `NOTICE`, and writes `dist/signal4kaios.zip` plus `dist/signal4kaios-<version>.zip`.

1. Bump `b2g_features.version` in [`app/manifest.webmanifest`](../app/manifest.webmanifest) (and `version` in [`package.json`](../package.json)). Never change `id` / `origin` (`signal4kaios`).
2. Add a `## v<version>` section to [`CHANGELOG.md`](../CHANGELOG.md).
3. Commit, tag `v<version>`, and push the tag; [`.github/workflows/release.yml`](../.github/workflows/release.yml) installs the pinned Rust toolchain and wasm-bindgen CLI, builds the wasm module, runs the test suite, packages the ZIP, and publishes the GitHub Release.

## Licensing

The app's own code is GPL-3.0 ([`LICENSE`](../LICENSE)). The wasm module statically links Signal's libsignal, which is AGPL-3.0-only, so the wrapper crate in `native/libsignal-wasm/` is AGPL-3.0-only too. GPL-3.0 section 13 permits combining the two: the app's code stays under GPL-3.0, and AGPL-3.0's terms (including its network-interaction clause) apply to the combined work. Anyone distributing the ZIP must offer the corresponding source, which this repository is. [`NOTICE`](../NOTICE) records this.

## Code conventions

- No hard line wrapping in prose or comments.
- First-party UI modules in `app/js/` use the `App.*` namespace IIFE pattern and build DOM nodes with `App.util.el(tag, className, text)` (never `innerHTML` with untrusted content).
- All message read-modify-write updates in `store.js` go through `enqueueMutation`; all session decryptions in `transport.ts` go through `enqueueDecryptEnvelope`; every libsignal call that touches protocol records goes through `protocol.ts` so the hydrate/flush cycle stays under its lock.
- Generated protobuf messages keep unset proto2 fields on the prototype: build new messages with `create(Schema, {...})` instead of spreading an existing message.
- Never log private keys, signaling passwords, or provisioning codes.
