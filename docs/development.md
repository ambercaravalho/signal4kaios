# Development

Everything for working on signal4kaios v2.0.0: how the on-device Signal Protocol engine and KaiOS UI are built, tested, and packaged. [AGENTS.md](../AGENTS.md) has the condensed rules.

- [Ground rules](#ground-rules)
- [Architecture](#architecture)
- [On-device Signal engine](#on-device-signal-engine)
- [Developing and testing](#developing-and-testing)
- [Packaging and releasing](#packaging-and-releasing)
- [Code conventions](#code-conventions)

## Ground rules

- **Target platform:** KaiOS 3.0, 3.1 (Gecko 84), and 4.0 (Gecko 123). KaiOS 2.5 (Gecko 48) support was dropped in v2.0.0.
- **No backend or gateway:** All Signal protocol cryptography, device provisioning, WebSocket framing, and CDN attachment encryption happen directly on the phone.
- **Privileged CSP:** The app is packaged as a privileged KaiOS app (`manifest.webmanifest`); its CSP forbids inline scripts, inline styles, `eval`, and `new Function`.
- **Engine bundle:** The TypeScript Signal engine in [`src/engine/`](../src/engine) is bundled by `esbuild` into `app/vendor/signal-engine.bundle.js` (IIFE, ES2020 target, zero `eval`) and loaded by [`app/index.html`](../app/index.html) as `window.App.signal`.

## Architecture

```
Signal WSS (/v1/websocket/)
  ──▶ ws.js ──▶ App.signal (decryptEnvelope) ──▶ normalize.js ──▶ store.js ──▶ IndexedDB (db.js)
                                                                      │
                                                                      └──▶ js/screens/* patch the DOM
```

- **Receive:** [`ws.js`](../app/js/ws.js) connects directly to `wss://chat.signal.org/v1/websocket/?agent=OWD&login=<aci>.<deviceId>&password=<password>`. Incoming binary `WebSocketMessage` protobuf frames for `PUT /api/v1/message` are decrypted in serial order by `App.signal.processIncomingEnvelope`, converted to normalized envelope JSON, passed through [`normalize.js`](../app/js/normalize.js) into [`store.js`](../app/js/store.js), persisted in IndexedDB ([`db.js`](../app/js/db.js)), and only then acknowledged (`200 OK` `WebSocketResponseMessage`) to Signal's server.
- **Offline queue:** Signal servers buffer undelivered messages while the phone is offline and send `PUT /api/v1/queue/empty` once the initial queue has drained. `ws.js` ingests initial queued messages silently (`silent: true`) before switching to live notifications.
- **Send:** Screens call `App.store.send*`, which writes an optimistic `pending` record and calls [`api.js`](../app/js/api.js) → `App.signal.send*`. The engine encrypts the `Content` protobuf for each recipient device using X3DH / Double Ratchet (automatically handling `409` extra/missing devices and `410` stale devices) and delivers via `PUT /v1/messages/<recipient>` over `mozSystem` XHR ([`http.js`](../app/js/http.js)).

## On-device Signal engine

Source files live in [`src/engine/`](../src/engine):

| File | Responsibility |
|---|---|
| `src/engine/proto.ts` | Zero-`eval` binary protobuf wire reader/writer and codecs for `WebSocketMessage`, `Envelope`, `Content`, `DataMessage`, `SyncMessage`, `ReceiptMessage`, `TypingMessage`, `EditMessage`, `ProvisionEnvelope`, `ProvisionMessage`, `SignalMessage`, `PreKeySignalMessage`, `SenderKeyMessage`, and `UnidentifiedSenderMessage` |
| `src/engine/crypto/curve.ts` | Curve25519 ECDH key agreement and Signal XEdDSA 64-byte signature calculation/verification (`@noble/curves/ed25519`) |
| `src/engine/crypto/kem.ts` | Post-Quantum ML-KEM-1024 / Kyber-1024 key generation, signing, encapsulation, and decapsulation (`@noble/post-quantum`) |
| `src/engine/crypto/primitives.ts` | HKDF-SHA256, HMAC-SHA256, SHA-256/512 (`@noble/hashes`), WebCrypto AES-256-CBC / AES-256-CTR / AES-256-GCM, and Signal ISO/IEC 7816-4 message padding |
| `src/engine/crypto/attachment.ts` | Signal CDN attachment encryption/decryption (64-byte AES-256-CBC + HMAC-SHA256 + SHA-256 digest) and AES-256-GCM profile field encryption |
| `src/engine/protocol/session.ts` | Signal v3/v4 X3DH + PQXDH initiator/responder and Double Ratchet session state machine with out-of-order skipped message keys |
| `src/engine/protocol/sealed-sender.ts` | Unidentified Delivery (Sealed Sender v1/v2) ephemeral+static ECDH + AES-CTR + HMAC-SHA256 and `UnidentifiedAccessKey` derivation |
| `src/engine/protocol/sender-keys.ts` | Group `SenderKeyDistributionMessage` and `SenderKeyMessage` ratchet and XEdDSA authentication |
| `src/engine/protocol/fingerprint.ts` | 60-digit numeric Safety Number and scannable `CombinedFingerprints` QR protobuf (5200 SHA-512 iterations) |
| `src/engine/provisioning.ts` | Linked Device QR provisioning over `wss://chat.signal.org/v1/websocket/provisioning/`, `ProvisionEnvelope` decryption, `PUT /v1/devices/{code}`, and ACI/PNI `PUT /v2/keys` |
| `src/engine/storage.ts` | `SignalProtocolStore` interface, `MemorySignalStore` (for tests), and `IndexedDbSignalStore` (backed by `App.db` v3 stores: `signal_keystore`, `signal_identities`, `signal_sessions`, `signal_prekeys`, `signal_sender_keys`) |
| `src/engine/storage-service.ts` | Signal Encrypted Storage Service (`StorageManifest`, `ContactRecord`, `GroupV2Record`, `AccountRecord`) keyed by `ProvisionMessage.masterKey` |
| `src/engine/profiles.ts` | Encrypted Signal profile fetch/upload (`GET/PUT /v1/profile`), CDN profile avatar decryption, and username hash lookup |
| `src/engine/groups-v2.ts` | Groups V2 `MasterKey` key derivation (`groupIdentifier`, `secretKey`, `blobKey`), `GroupContextV2` builder, and `DecryptedGroup` parser |
| `src/engine/transport.ts` | `SignalClient` envelope decryption queue, `DecryptionErrorMessage` retry receipts, Sealed Sender & Sender Key fanout, 409/410 retry handling, CDN attachment upload/download, and sync blob parsing |
| `src/engine/index.ts` | Attaches `App.signal` bridge for `app/js/*` |

## Developing and testing

```sh
npm install
npm run typecheck   # TypeScript type-checking
npm test            # Unit tests for XEdDSA, X3DH, Double Ratchet, Sealed Sender, Sender Keys, Provisioning, Attachments, Safety Numbers
npm run build       # Bundle src/engine/index.ts -> app/vendor/signal-engine.bundle.js
sh app/scripts/package.sh
```

Install on a KaiOS 3.0, 3.1, or 4.0 device with [`install-kaios3plus.sh`](../app/scripts/install-kaios3plus.sh) or via OStore's Manual Install tab, and inspect in Firefox `about:debugging`. **Settings → Debug log** is the primary on-device diagnostic tool.

## Packaging and releasing

```sh
sh app/scripts/package.sh
```

Builds `app/vendor/signal-engine.bundle.js`, verifies `app/manifest.webmanifest` and `app/sw.js`, and writes `dist/signal4kaios.zip` plus `dist/signal4kaios-<version>.zip`.

1. Bump `b2g_features.version` in [`app/manifest.webmanifest`](../app/manifest.webmanifest) (and `version` in [`package.json`](../package.json)). Never change `id` / `origin` (`signal4kaios`).
2. Add a `## v<version>` section to [`CHANGELOG.md`](../CHANGELOG.md).
3. Commit, tag `v<version>`, and push the tag; [`.github/workflows/release.yml`](../.github/workflows/release.yml) runs the test suite, packages the ZIP, and publishes the GitHub Release.

## Code conventions

- No hard line wrapping in prose or comments.
- First-party UI modules in `app/js/` use the `App.*` namespace IIFE pattern and build DOM nodes with `App.util.el(tag, className, text)` (never `innerHTML` with untrusted content).
- All message read-modify-write updates in `store.js` go through `enqueueMutation`; all session decryptions in `transport.ts` go through `enqueueDecryptEnvelope`.
- Never log private keys, signaling passwords, or provisioning codes.
