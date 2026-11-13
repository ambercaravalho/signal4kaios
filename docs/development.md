# Development

Building, testing, and releasing Beacon (this repository, signal4kaios). How the pieces fit is in [Architecture](architecture.md); agent and editor rules live in [`.cursor/rules/`](../.cursor/rules).

- [Prerequisites](#prerequisites)
- [Build and test](#build-and-test)
- [Running on a phone](#running-on-a-phone)
- [Calls](#calls)
- [Bumping the libsignal pin](#bumping-the-libsignal-pin)
- [Regenerating protobuf codecs](#regenerating-protobuf-codecs)
- [Releasing](#releasing)
- [Conventions](#conventions)
- [Licensing](#licensing)

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| [Node.js](https://nodejs.org) | 22+ | |
| [rustup](https://rustup.rs) | any | Installs the toolchain and `wasm32-unknown-unknown` target from [`rust-toolchain.toml`](../src/native/libsignal-wasm/rust-toolchain.toml) automatically |
| [`protoc`](https://protobuf.dev/installation/) | any recent | libsignal's build scripts need it: `brew install protobuf` or `apt install protobuf-compiler` |
| LLVM `clang` and `llvm-ar` with the wasm32 target | any recent | `ring` (rustls's crypto) compiles C for wasm32. Apple's clang lacks the target, so on macOS run `brew install llvm`; on Linux `apt install clang llvm`. [`build.sh`](../src/native/libsignal-wasm/build.sh) finds them and fails with this hint if they're missing |
| [wasm-bindgen CLI](https://github.com/rustwasm/wasm-bindgen) | exactly the `wasm-bindgen` version in [`Cargo.toml`](../src/native/libsignal-wasm/Cargo.toml) | `cargo install wasm-bindgen-cli --version 0.2.126 --locked` |
| [CMake](https://cmake.org) and `curl` | any recent | Build BoringSSL for [contact discovery](#contact-discovery-build): `brew install cmake` or `apt install cmake` (plus `libclang-dev` on Linux, for bindgen). [Ninja](https://ninja-build.org) is used when present. `build.sh` downloads the pinned [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) itself; set `WASI_SDK_PATH` to use your own |
| [Binaryen](https://github.com/WebAssembly/binaryen) `wasm-opt` | optional | Shrinks the module when present (about 2.2 MB to 2.0 MB) |

> [!WARNING]
> Run `cargo install` from outside `src/native/libsignal-wasm/`. That folder's `.cargo/config.toml` forces the wasm32 target, which breaks building host tools.

## Build and test

```sh
npm install
npm run build:wasm   # src/native/libsignal-wasm -> src/app/vendor/libsignal_wasm_bg.wasm (+ glue in src/native/libsignal-wasm/pkg)
npm run typecheck
npm test             # unit, interop, known-answer, and UI tests
npm run package      # bundle + checks -> dist/signal4kaios.zip and dist/signal4kaios-<version>.zip
```

| Script | Does |
| --- | --- |
| `build:wasm` | BoringSSL and the patched `libc` ([below](#contact-discovery-build)) → `cargo build` → `wasm-bindgen --target web` → optional `wasm-opt` → copy to `src/app/vendor/` |
| `build` | [`scripts/build.mjs`](../scripts/build.mjs): esbuild bundles [`src/ui/main.tsx`](../src/ui/main.tsx) with the engine, the wasm-bindgen glue, and the CSS into `src/app/build/app.js` and `app.css` (IIFE, `firefox84`). It keeps only the emoji KaiOS 3.x can draw. A second entry bundles the Backups codec and the history frame mapper into `backup.js`, which the app loads only while it imports message history after linking, and a third builds the call audio worklet into `call-worklet.js`. `--analyze` prints what makes up `app.js` |
| `icons` | [`scripts/icons.mjs`](../scripts/icons.mjs): renders [`beacon.svg`](../src/app/assets/icons/beacon.svg) to the 56 and 112 px launcher PNGs. Run it after editing the SVG and commit the PNGs |
| `typecheck` | `tsc --noEmit` over `src/engine/`, `src/ui/`, and `test/` |
| `test` | Bundles `test/*.test.ts` and `test/*.test.tsx` and runs them with `node --test`. The UI tests render screens with `preact-render-to-string` over `fake-indexeddb`, and check that everyday wording stays free of technical terms |
| `gen:protos` | Regenerates `src/engine/gen/` from `src/protos/` |
| `test:live` | Runs [`test/live/`](../test/live) against Signal's real servers over the pinned TLS client: the provisioning socket, unauthenticated chat and storage requests, and a pin failure against a non-Signal host. Needs network access, so CI doesn't run it |
| `package` | [`scripts/package.sh`](../scripts/package.sh): builds, fails on `eval(`/`new Function(` in shipped scripts, checks required files, adds `LICENSE` and `NOTICE`, and zips `src/app/`. `SKIP_WASM_BUILD=1` reuses an earlier `build:wasm` |

`build:wasm` must run before `typecheck` and `test`: TypeScript imports the generated glue from `src/native/libsignal-wasm/pkg/`, and the tests load the compiled module.

The interop tests ([`test/interop.test.ts`](../test/interop.test.ts)) run our wasm build against Signal's official Node library, [`@signalapp/libsignal-client`](https://www.npmjs.com/package/@signalapp/libsignal-client), pinned to the same libsignal release and never bundled. They exchange sessions, Sealed Sender, and Sender Key messages in both directions, and compare safety numbers, username hashes, zkgroup values, Kyber records, provisioning envelopes, and message backup keys, and read link-and-sync archives encrypted with the official library's keys. [`test/group-send.test.ts`](../test/group-send.test.ts) has the official library play the server for group sends: it issues group send endorsements, verifies our `Group-Send-Token`, and splits our multi-recipient Sealed Sender messages per recipient. The official library ships prebuilt binaries for Linux, macOS, and Windows on x64 and arm64.

> [!NOTE]
> Storage Service and profile known-answer vectors were computed from Signal-Desktop's formulas, since Desktop publishes none; they guard against regressions rather than prove server compatibility.

## Running on a phone

Install with [`scripts/install.sh`](../scripts/install.sh) (needs [adb](https://developer.android.com/tools/adb) and [`appscmd`](https://github.com/kaiostech/appscmd)) or OStore's Manual Install, and debug with Firefox at `about:debugging`. On the phone, **Settings → Debug** is the main diagnostic: it shows the account and device IDs, PreKey counts, and connection state, and can share a log with the phone number and IDs redacted. Connections to Signal work only through the app's pinned TLS client, so a regression there shows up as close code 1015.

Test KaiOS 4.0 with `api-daemon`'s stock policy, with no `'wasm-unsafe-eval'` added to the `csp` line in its `config.toml`, since that's what users have. `adb logcat | grep -i wasm-eval` then shows a policy error only for the first launch after an install or update, followed by one reload ([how it works](architecture.md#webassembly-on-kaios-40)). See the [KaiOS developer docs](https://developer.kaiostech.com) for the platform itself.

## Calls

How calls work is in [Architecture](architecture.md#calls). [`test/engine-calling.test.ts`](../test/engine-calling.test.ts) covers the network and media side without a phone: STUN against the RFC 5769 test vector, TURN against a fake relay, two ICE agents connecting to each other, the jitter buffer, encoder pacing, and the call manager's states, with Node's mock timers standing in for the ring and offer timeouts. [`test/ui-calls.test.tsx`](../test/ui-calls.test.tsx) covers call log lines and the call screen. Both run in `npm test`.

The audio settings come from measurements on a TCL T440W running KaiOS 4.0:

| Finding | Result |
| --- | --- |
| A `telephony` `AudioContext` plays through the earpiece only when the manifest sets `b2g_features.core: true`. It's a separate Gecko graph, and connecting the microphone to it fails with a sample-rate error | Earpiece mode captures in a normal context and plays in a telephony one. The speaker uses one content context |
| `echoCancellation: true` selects the voice-call input (`adb logcat` shows HAL source 7, `audio-record-voip`) and the DSP's `Voip_Fluence_SMECNS` echo and noise canceller. Without it the phone uses its recording input, with noise suppression only | Echo cancellation and noise suppression on |
| Gecko's automatic gain control overloads its media graph thread: the microphone context's clock ran 4.3 to 9.5% slower than the wall clock, so microphone audio was dropped and sounded choppy | Automatic gain control off |
| Opus takes 2.3 ms per 60 ms frame in a tight loop at complexity 3, but 17.5 ms when paced every 60 ms as in a call (11.9 ms at complexity 1, 23.3 ms at 5), because the scheduler keeps light periodic work on the efficiency cores | Start at complexity 3, and step down to 1, then 0, when encodes average more than half the frame time |
| App start-up and other main-thread work stall it for up to 335 ms | Playback keeps 150 ms queued at first, grows the queue by 40 ms after a stall runs it dry (up to 300 ms), and shrinks it by 20 ms after 10 calm seconds (down to 100 ms) |

> [!NOTE]
> `core: true` is what lets a packaged app use the telephony and ringer audio channels. Without it, the call can only play through the loudspeaker.

On the phone, a call needs a second Signal account to call. Without one, `adb logcat | grep -i -e audio_hw -e fluence` still confirms which input and DSP path a microphone test selects, and **Settings → Debug** shares a log that says why a call failed to start, lost its relay, or failed to connect to a device, with no keys, addresses, or relay credentials.

## Bumping the libsignal pin

1. Pick a [libsignal release](https://github.com/signalapp/libsignal/releases) and set its commit as the `rev` of **every** libsignal crate in [`Cargo.toml`](../src/native/libsignal-wasm/Cargo.toml).
2. Match [`rust-toolchain.toml`](../src/native/libsignal-wasm/rust-toolchain.toml) to libsignal's `rust-toolchain`, and bump `wasm-bindgen` (the crate pin and your local CLI; [the shared CI build action](../.github/actions/build/action.yml) reads the pin from `Cargo.toml`) if libsignal's lockfile moved.
3. Run `cargo update` in `src/native/libsignal-wasm/`, fix any wrapper compile errors (libsignal's Rust API isn't stable), and commit `Cargo.lock`.
4. Set `@signalapp/libsignal-client` in [`package.json`](../package.json) to the same version, and update the version asserted in [`test/protocol.test.ts`](../test/protocol.test.ts).
5. If `cargo update` moved `libc`, set `LIBC_VERSION` and `LIBC_SHA256` (the `checksum` from the old registry entry in `Cargo.lock`, or `shasum -a 256` of the `.crate` from crates.io) in [`wasi-deps.sh`](../src/native/libsignal-wasm/wasi-deps.sh); it fails loudly if the line it patches has moved. If `boring-sys` moved, the BoringSSL build reruns by itself.
6. If `chat_websocket.proto` or `cds2.proto` changed, update them as below, then run the full [definition of done](#conventions).

### Contact discovery build

Phone number lookup verifies Signal's CDSI enclave with libsignal's `attest` crate, which uses BoringSSL (Signal's `boring` fork), and BoringSSL is C and C++ that expects a libc. [`wasi-deps.sh`](../src/native/libsignal-wasm/wasi-deps.sh), sourced by `build.sh`, makes that work for `wasm32-unknown-unknown` without forking `boring`:

| Step | Why |
| --- | --- |
| Download wasi-sdk 34 into `target/` (SHA-256 pinned) | Its clang, wasi-libc, and libc++ compile BoringSSL for WebAssembly |
| Build `libcrypto.a` and `libssl.a` from `boring-sys`'s own BoringSSL sources into `target/boringssl-wasi/`, with `OPENSSL_NO_ASM`, `OPENSSL_NO_SOCK`, and `OPENSSL_NO_THREADS_CORRUPT_MEMORY_AND_LEAK_SECRETS_IF_THREADED` | `boring-sys` links a prebuilt BoringSSL when `BORING_BSSL_PATH` is set. wasi-libc has no threads, so `CMAKE_HAVE_LIBC_PTHREAD=ON` satisfies BoringSSL's `find_package(Threads)` without linking anything; the module is single-threaded |
| Set `BINDGEN_EXTRA_CLANG_ARGS_wasm32_unknown_unknown` to the WASI headers, `-D__wasi__`, and `-fvisibility=default` | Without default visibility, clang's wasm target hides BoringSSL's declarations and bindgen generates no functions |
| Download the locked `libc` crate into `vendor/libc` (gitignored, SHA-256 pinned) and add `wasm32-unknown-unknown` to its WASI branch; `[patch.crates-io]` in `Cargo.toml` points there | `libc` defines no C types for `wasm32-unknown-unknown`, which `boring` and `attest` need. Its WASI definitions match the wasi-libc that BoringSSL is linked with. This one-line patch is the only change to upstream code |
| [`build.rs`](../src/native/libsignal-wasm/build.rs) links wasi-libc, libc++, and libc++abi (the no-exceptions build) | BoringSSL calls `malloc`, `abort`, `getentropy`, and C++ `operator delete` |

The module then imports eight `wasi_snapshot_preview1` functions. esbuild aliases that module to [`src/engine/protocol/wasi.ts`](../src/engine/protocol/wasi.ts) (the `alias` in `scripts/build.mjs` and `--alias` in the npm test scripts), which serves the clock and `crypto.getRandomValues` and refuses file access; nothing in the module opens files. wasi-libc's allocator and Rust's share the wasm memory, each taking its own pages from `memory.grow`. The attestation check takes the current time from JavaScript, since `SystemTime::now` panics on `wasm32-unknown-unknown`.

## Regenerating protobuf codecs

[`src/protos/`](../src/protos) holds unmodified copies of Signal's schemas, at the tags recorded in [`buf.yaml`](../buf.yaml):

| Folder | Source |
| --- | --- |
| `src/protos/signal-desktop/` | [Signal-Desktop](https://github.com/signalapp/Signal-Desktop/tree/main/protos) v8.34.0 (`Backups.proto`, `DeviceMessages.proto`, `DeviceName.proto`, `Groups.proto`, `SignalService.proto`, `SignalStorage.proto`) |
| `src/protos/libsignal/` | [libsignal](https://github.com/signalapp/libsignal/tree/main/rust/net/src/proto) v0.106.2 (`chat_websocket.proto`, `cds2.proto`) |
| `src/protos/ringrtc/` | [RingRTC](https://github.com/signalapp/ringrtc/tree/main/protobuf/protobuf) v2.75.0 (`signaling.proto`, `rtp_data.proto`, `group_call.proto`) |

To update, copy the same files from the new tags, update `buf.yaml`, and run `npm run gen:protos`. [buf](https://buf.build/docs/) and [protoc-gen-es](https://github.com/bufbuild/protobuf-es) regenerate `src/engine/gen/`, which is committed; CI fails if it differs from a fresh generation.

## Releasing

1. Bump `b2g_features.version` in [`src/app/manifest.webmanifest`](../src/app/manifest.webmanifest) and `version` in [`package.json`](../package.json). Never change `id` or `origin` (`signal4kaios`).
2. Add a `## v<version>` section to [`CHANGELOG.md`](../CHANGELOG.md); it becomes the release notes.
3. Commit, tag `v<version>`, and push the tag. [`release.yml`](../.github/workflows/release.yml) builds the wasm module with the pinned toolchain, runs the tests, packages, and publishes the [GitHub Release](https://github.com/ambercaravalho/signal4kaios/releases).

## Conventions

Definition of done, also run by [CI](../.github/workflows/ci.yml):

- [ ] `npm run build:wasm`
- [ ] `npm run gen:protos` leaves `src/engine/gen/` unchanged
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run package`

The coding rules (app conventions, engine invariants, CSP, logging, docs style) are in [`.cursor/rules/`](../.cursor/rules).

## Licensing

The app's own code is GPL-3.0 ([`LICENSE`](../LICENSE)). The wasm module statically links libsignal, which is AGPL-3.0-only, so the wrapper crate is AGPL-3.0-only too. GPL-3.0 section 13 permits the combination: the app's code stays GPL-3.0, and the AGPL-3.0's terms, including its network clause, apply to the combined work. Anyone distributing the ZIP must offer the corresponding source, which this repository is. [`NOTICE`](../NOTICE) records this and ships in the ZIP.
