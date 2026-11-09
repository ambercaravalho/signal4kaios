# Development

Building, testing, and releasing signal4kaios. How the pieces fit is in [Architecture](architecture.md); agent and editor rules live in [`.cursor/rules/`](../.cursor/rules).

- [Prerequisites](#prerequisites)
- [Build and test](#build-and-test)
- [Running on a phone](#running-on-a-phone)
- [Bumping the libsignal pin](#bumping-the-libsignal-pin)
- [Regenerating protobuf codecs](#regenerating-protobuf-codecs)
- [Releasing](#releasing)
- [Conventions](#conventions)
- [Phone-number lookup (CDSI): spike findings](#phone-number-lookup-cdsi-spike-findings)
- [Licensing](#licensing)

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| [Node.js](https://nodejs.org) | 20+ | |
| [rustup](https://rustup.rs) | any | Installs the toolchain and `wasm32-unknown-unknown` target from [`rust-toolchain.toml`](../native/libsignal-wasm/rust-toolchain.toml) automatically |
| [`protoc`](https://protobuf.dev/installation/) | any recent | libsignal's build scripts need it: `brew install protobuf` or `apt install protobuf-compiler` |
| [wasm-bindgen CLI](https://github.com/rustwasm/wasm-bindgen) | exactly the `wasm-bindgen` version in [`Cargo.toml`](../native/libsignal-wasm/Cargo.toml) | `cargo install wasm-bindgen-cli --version 0.2.126 --locked` |
| [Binaryen](https://github.com/WebAssembly/binaryen) `wasm-opt` | optional | Shrinks the module when present |

> [!WARNING]
> Run `cargo install` from outside `native/libsignal-wasm/`. That folder's `.cargo/config.toml` forces the wasm32 target, which breaks building host tools.

## Build and test

```sh
npm install
npm run build:wasm   # native/libsignal-wasm -> app/vendor/libsignal_wasm_bg.wasm (+ glue in native/libsignal-wasm/pkg)
npm run typecheck
npm test             # unit, interop, and known-answer tests
npm run package      # bundle + checks -> dist/signal4kaios.zip and dist/signal4kaios-<version>.zip
```

| Script | Does |
| --- | --- |
| `build:wasm` | `cargo build` → `wasm-bindgen --target web` → optional `wasm-opt` → copy to `app/vendor/` |
| `build` | esbuild bundles [`engine/index.ts`](../engine/index.ts) and the wasm-bindgen glue into `app/vendor/signal-engine.bundle.js` (IIFE, ES2020) |
| `typecheck` | `tsc --noEmit` over `engine/` and `test/` |
| `test` | Bundles `test/*.test.ts` and runs them with `node --test` |
| `gen:protos` | Regenerates `engine/gen/` from `protos/` |
| `package` | [`scripts/package.sh`](../scripts/package.sh): builds, fails on `eval(`/`new Function(` in shipped scripts, checks required files, adds `LICENSE` and `NOTICE`, and zips `app/`. `SKIP_WASM_BUILD=1` reuses an earlier `build:wasm` |

`build:wasm` must run before `typecheck` and `test`: TypeScript imports the generated glue from `native/libsignal-wasm/pkg/`, and the tests load the compiled module.

The interop tests ([`test/interop.test.ts`](../test/interop.test.ts)) run our wasm build against Signal's official Node library, [`@signalapp/libsignal-client`](https://www.npmjs.com/package/@signalapp/libsignal-client), pinned to the same libsignal release and never bundled. They exchange sessions, Sealed Sender, and Sender Key messages in both directions, and compare safety numbers, username hashes, zkgroup values, Kyber records, and provisioning envelopes. The official library ships prebuilt binaries for Linux, macOS, and Windows on x64 and arm64.

> [!NOTE]
> Storage Service and profile known-answer vectors were computed from Signal-Desktop's formulas, since Desktop publishes none; they guard against regressions rather than prove server compatibility.

## Running on a phone

Install with [`scripts/install.sh`](../scripts/install.sh) (needs [adb](https://developer.android.com/tools/adb) and [`appscmd`](https://github.com/kaiostech/appscmd)) or OStore's Manual Install, and debug with Firefox at `about:debugging`. On the phone, **Settings → Debug log** is the main diagnostic. See the [KaiOS developer docs](https://developer.kaiostech.com) for the platform itself.

## Bumping the libsignal pin

1. Pick a [libsignal release](https://github.com/signalapp/libsignal/releases) and set its commit as the `rev` of **every** libsignal crate in [`Cargo.toml`](../native/libsignal-wasm/Cargo.toml).
2. Match [`rust-toolchain.toml`](../native/libsignal-wasm/rust-toolchain.toml) to libsignal's `rust-toolchain`, and bump `wasm-bindgen` (crate, CLI, and `WASM_BINDGEN_VERSION` in [`ci.yml`](../.github/workflows/ci.yml)) if libsignal's lockfile moved.
3. Run `cargo update` in `native/libsignal-wasm/`, fix any wrapper compile errors (libsignal's Rust API isn't stable), and commit `Cargo.lock`.
4. Set `@signalapp/libsignal-client` in [`package.json`](../package.json) to the same version, and update the version asserted in [`test/protocol.test.ts`](../test/protocol.test.ts).
5. If `chat_websocket.proto` changed, update it as below, then run the full [definition of done](#conventions).

## Regenerating protobuf codecs

[`protos/`](../protos) holds unmodified copies of Signal's schemas, at the tags recorded in [`buf.yaml`](../buf.yaml):

| Folder | Source |
| --- | --- |
| `protos/signal-desktop/` | [Signal-Desktop](https://github.com/signalapp/Signal-Desktop/tree/main/protos) v8.34.0 |
| `protos/libsignal/` | [libsignal](https://github.com/signalapp/libsignal/tree/main/rust/net/src/proto) v0.106.2 (`chat_websocket.proto`) |

To update, copy the same files from the new tags, update `buf.yaml`, and run `npm run gen:protos`. [buf](https://buf.build/docs/) and [protoc-gen-es](https://github.com/bufbuild/protobuf-es) regenerate `engine/gen/`, which is committed; CI fails if it differs from a fresh generation.

## Releasing

1. Bump `b2g_features.version` in [`app/manifest.webmanifest`](../app/manifest.webmanifest) and `version` in [`package.json`](../package.json). Never change `id` or `origin` (`signal4kaios`).
2. Add a `## v<version>` section to [`CHANGELOG.md`](../CHANGELOG.md); it becomes the release notes.
3. Commit, tag `v<version>`, and push the tag. [`release.yml`](../.github/workflows/release.yml) builds the wasm module with the pinned toolchain, runs the tests, packages, and publishes the [GitHub Release](https://github.com/ambercaravalho/signal4kaios/releases).

## Conventions

Definition of done, also run by [CI](../.github/workflows/ci.yml):

- [ ] `npm run build:wasm`
- [ ] `npm run gen:protos` leaves `engine/gen/` unchanged
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run package`

The coding rules (app module shape, engine invariants, CSP, logging, docs style) are in [`.cursor/rules/`](../.cursor/rules).

## Phone-number lookup (CDSI): spike findings

Looking up a phone number that isn't in your synced contacts needs Signal's contact discovery service (CDSI), an SGX enclave reached over `wss://cdsi.signal.org/v1/<mrenclave>/discovery`. A time-boxed spike against libsignal v0.106.2 ended in **no-go for now**, so `App.api.searchNumbers` still doesn't query Signal and a chat can only start with numbers from the synced contacts.

| Question | Finding |
| --- | --- |
| Does libsignal's `attest` crate build for `wasm32-unknown-unknown`? | Not as-is. `attest` uses BoringSSL (`boring-signal`) throughout DCAP attestation (X.509 chain and CRL checks, P-256 ECDSA over the SGX quote), so it can't be gated off without reimplementing enclave verification, which the project rules forbid. A direct build fails because `wasm32-unknown-unknown` has no C library. |
| Does BoringSSL itself build for WebAssembly? | `libcrypto` does, with [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) 25, `OPENSSL_NO_ASM`, `OPENSSL_NO_SOCK`, `OPENSSL_NO_THREADS_CORRUPT_MEMORY_AND_LEAK_SECRETS_IF_THREADED`, and a one-line CMake patch so WASI skips `find_package(Threads)`. The archive is 14 MB before LTO and imports only ordinary libc (stdio, malloc, `getentropy`, `time`), which would need a WASI shim in the wasm-bindgen glue. |
| Does `boring-sys` link that build into our wasm module? | Not yet. With `BORING_BSSL_PATH` pointing at the WASI build, bindgen generates the BoringSSL types for `wasm32-unknown-unknown` but no function declarations, so `boring-sys` fails to compile. Fixing it means patching Signal's `boring` fork and carrying that patch across libsignal bumps. |
| Can KaiOS open the CDSI WebSocket with the right auth? | Not with the `WebSocket` API. libsignal sends the `GET /v2/directory/auth` credentials as an HTTP `Authorization` header on the upgrade request (`rust/net/src/connect_state.rs`), and browser WebSockets can't set headers. The only route would be a privileged `TCPSocket` with TLS plus a hand-written WebSocket upgrade, which is untested on KaiOS 3 and 4. |

Revisit when any of these change: libsignal moves attestation off BoringSSL, `boring` gains a wasm32 target, or CDSI accepts credentials without a header. A follow-up would also need the `cds2` Noise handshake from `attest`, the CDSI request and token protos from `rust/net`, and a size check on the larger wasm module.

## Licensing

The app's own code is GPL-3.0 ([`LICENSE`](../LICENSE)). The wasm module statically links libsignal, which is AGPL-3.0-only, so the wrapper crate is AGPL-3.0-only too. GPL-3.0 section 13 permits the combination: the app's code stays GPL-3.0, and the AGPL-3.0's terms, including its network clause, apply to the combined work. Anyone distributing the ZIP must offer the corresponding source, which this repository is. [`NOTICE`](../NOTICE) records this and ships in the ZIP.
