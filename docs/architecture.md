# Architecture

How Beacon (the signal4kaios repository) turns a KaiOS phone into a Signal linked device. For building and testing, see [Development](development.md).

- [Overview](#overview)
- [Network](#network)
- [Repository layout](#repository-layout)
- [The app](#the-app)
- [Receiving](#receiving)
- [Sending](#sending)
- [Storage Service writes](#storage-service-writes)
- [Group changes](#group-changes)
- [Linking](#linking)
- [The libsignal wrapper](#the-libsignal-wrapper)
- [Engine modules](#engine-modules)
- [Storage](#storage)
- [Security model](#security-model)

## Overview

The app has three layers, and the phone talks only to Signal's servers.

```mermaid
flowchart LR
  subgraph phone [KaiOS phone]
    ui["src/ui: Preact screens, store, ws"]
    engine["src/engine: signalBridge"]
    wasm["libsignal_wasm_bg.wasm"]
    idb[(IndexedDB)]
    ui <--> engine
    engine <--> wasm
    ui <--> idb
    engine <--> idb
  end
  chat["chat.signal.org"]
  storage["storage.signal.org"]
  cdn["cdn*.signal.org"]
  ui <-->|"WebSocket over pinned TLS"| chat
  engine -->|"HTTPS over pinned TLS"| chat
  engine -->|"HTTPS over pinned TLS"| storage
  engine -->|"HTTPS over pinned TLS"| cdn
```

| Layer | Where | Role |
| --- | --- | --- |
| **App** | [`src/ui/`](../src/ui) | [Preact](https://preactjs.com) and TypeScript: screens, components, and the data layer (store, WebSocket, IndexedDB). See [The app](#the-app) |
| **Engine** | [`src/engine/`](../src/engine) | TypeScript Signal engine, imported by the app as `signalBridge` and bundled with it into `src/app/build/app.js` |
| **libsignal** | [`src/native/libsignal-wasm/`](../src/native/libsignal-wasm) | A wasm-bindgen wrapper over Signal's official [libsignal](https://github.com/signalapp/libsignal) crates, shipped as `src/app/vendor/libsignal_wasm_bg.wasm` |

Wire formats come from Signal-Desktop's and libsignal's own `.proto` files in [`src/protos/`](../src/protos), compiled to TypeScript with [protobuf-es](https://github.com/bufbuild/protobuf-es).

## Network

Every Signal service (`chat`, `storage`, `cdn`, `cdn2`, `cdn3`) presents a certificate from Signal's own root, `CN=Signal Messenger`, which no browser trusts. Gecko's `WebSocket` and XHR therefore fail on a stock phone with close code 1015. The app does TLS itself instead, the way Signal's own apps do:

```mermaid
flowchart LR
  callers["ui/data/http.ts, ui/data/ws.ts, provisioning.ts"] --> net["signalBridge.net (src/engine/net/transport)"]
  net --> h1["http1.ts / websocket.ts"]
  h1 --> tls["tls-stream.ts"]
  tls --> conn["TlsConn in wasm (rustls, pinned roots)"]
  tls --> tcp["tcp.ts: KaiOS TCPSocket"]
```

| Piece | Role |
| --- | --- |
| [`src/native/libsignal-wasm/src/tls.rs`](../src/native/libsignal-wasm/src/tls.rs) | A sans-I/O [rustls](https://github.com/rustls/rustls) client that trusts only libsignal's pinned roots (`signal.cer`, `signal-ed25519.cer` in `res/`) and refuses any host outside `signal.org` |
| [`transport/tcp.ts`](../src/engine/net/transport/tcp.ts) | The raw socket, from the `tcp-socket` manifest permission (`TCPSocket`, or `navigator.mozTCPSocket` on older builds) |
| [`transport/tls-stream.ts`](../src/engine/net/transport/tls-stream.ts) | Pumps bytes between the socket and `TlsConn`, and resolves once the handshake is done |
| [`transport/http1.ts`](../src/engine/net/transport/http1.ts) | HTTP/1.1 with keep-alive, at most 6 requests per host at once, capped response sizes, and timeouts |
| [`transport/websocket.ts`](../src/engine/net/transport/websocket.ts) | An RFC 6455 client shaped like the browser `WebSocket`, so callers use either one |

Only `*.signal.org` goes through this path. Other hosts, and environments without `TCPSocket` (desktop browsers, the tests' fallbacks), use mozSystem XHR and the platform `WebSocket`. A redirect off Signal's hosts drops the `Authorization` header and continues over XHR.

On a rooted phone whose Gecko trusts Signal's root ([setup](setup.md#optional-for-rooted-phones-trust-signals-certificate), [`scripts/signal-cert.mjs`](../scripts/signal-cert.mjs)), [`src/ui/data/nativeTls.ts`](../src/ui/data/nativeTls.ts) detects it with one unauthenticated `HEAD https://cdn.signal.org/` per launch, reconnect, and `online` event. While that succeeds, [`http.ts`](../src/ui/data/http.ts) sends requests to the attachment CDNs (`cdn`, `cdn2`, `cdn3`) over mozSystem XHR, capped at 200 MiB like the pinned client, and a network failure switches back to the pinned client for good. The platform trusts every public CA, so nothing carrying account credentials or keys takes this path: the chat socket, the chat and Storage Service APIs, and provisioning (where a forged server could substitute its own QR address) always stay pinned. Attachments are end-to-end encrypted and MAC-checked, and uploads use one-time upload forms.

### Signal proxy

With a [Signal proxy](https://signal.org/blog/help-iran-reconnect/) set (**Settings → Privacy → Proxy**, stored app-wide in `s4k.config`), each pinned connection has two TLS layers. The outer one is a `TCPSocket` opened with `useSecureTransport: true` to `<proxy>:443`, so Gecko checks the proxy's ordinary public certificate against the phone's CA store. Inside that stream `tls-stream.ts` runs the usual pinned `TlsConn` handshake with the Signal host's name as SNI, and the proxy (for example [Signal-TLS-Proxy](https://github.com/signalapp/Signal-TLS-Proxy)) forwards by reading that name. The proxy learns that a Signal host was reached, never the traffic or the credentials inside it. `createNet` holds the proxy host; [`src/ui/data/proxy.ts`](../src/ui/data/proxy.ts) parses `https://signal.tube/#<host>` and `sgnl://signal.tube/?host=<host>` links as untrusted input, and changing the setting drops kept-alive connections and reconnects the chat socket.

While a proxy is set nothing for Signal's hosts goes out directly: Faster connection's platform-TLS CDN path and its probe are skipped, the platform `WebSocket` fallback is refused, and a request to a `signal.org` host that can't use the pinned client fails instead of falling back to XHR. Link previews, and CDN redirects to hosts outside `signal.org`, still connect directly.

The chat WebSocket authenticates with an `Authorization: Basic` header on the upgrade request. Signal's server treats query-string credentials as an anonymous socket that never receives messages, which is why only the pinned client can carry the main connection.

A ServiceWorker can't use any of this, because workers have no `TCPSocket`, and the browser `WebSocket` can't set the header. So a closed app can't receive messages: [`sw.js`](../src/app/sw.js) only relays wake alarms to an open window and handles notification taps. See [the user guide](user-guide.md#known-limitations).

## Repository layout

```text
src/
  app/                    the packaged KaiOS app (zipped as-is)
    index.html            loads build/app.js and build/app.css
    build/                esbuild output (gitignored)
    assets/icons/         beacon.svg and the launcher PNGs rendered from it
    vendor/               libsignal_wasm_bg.wasm
    sw.js                 ServiceWorker: wake alarms and notification taps
  ui/                     the app (Preact + TypeScript)
    main.tsx              startup: theme, engine host, ServiceWorker, first screen
    app/                  router, focus and key handling, hooks, theme
    components/           shared building blocks (lists, dialogs, softkeys, QR, emoji)
    screens/              one module per screen or group of related screens
    data/                 store, ws, db, config, http, nativeTls, normalize, attachments, platform (B2G APIs)
    theme/                CSS tokens and styles
    strings.ts            every user-facing string, plus the Debug screen's wording
  engine/                 on-device Signal engine (signalBridge)
    protocol/             libsignal loader, protocol operations, PreKeys, protocol store
    net/                  HTTP shapes, protobuf helpers, provisioning, receive, send client
    net/transport/        pinned TLS over TCPSocket: HTTP/1.1 and WebSocket clients
    services/             Storage Service, profiles, Groups V2
    crypto/               attachment and profile cipher primitives
    gen/                  generated protobuf codecs (never hand-edited)
  native/libsignal-wasm/  Rust wrapper crate (AGPL-3.0-only)
  protos/                 vendored Signal .proto files
scripts/                  build.mjs, icons.mjs, package.sh, install.sh, signal-cert.mjs
test/                     unit, interop, and known-answer tests
docs/                     these guides
```

## The app

The app is a single Preact tree built for Gecko 84, the oldest engine it supports (KaiOS 3.0). [`scripts/build.mjs`](../scripts/build.mjs) bundles `src/ui/main.tsx`, the engine, and the CSS into `src/app/build/`, so `index.html` loads one script and one stylesheet, with no inline code for the privileged CSP to reject.

| Piece | Role |
| --- | --- |
| [`app/router.tsx`](../src/ui/app/router.tsx) | A screen stack. `router.push` opens a screen, `router.overlay` opens a menu or dialog above it and resolves a promise with the choice, `pop`/`replace`/`reset` move back. Screens below the top stay mounted, so going back keeps their state and scroll position |
| `useKeys`, `useSoftkeys` | Keys go to the top entry, innermost handler first. Each entry declares its softkey labels, and the left one defaults to **Back** on pushed screens |
| [`components/RowList.tsx`](../src/ui/components/RowList.tsx) | The KaiOS list most screens are built from: rows with optional section headers, toggles, and per-row center labels |
| [`data/store.ts`](../src/ui/data/store.ts) | Conversations and messages in IndexedDB, plus an event hub. Screens subscribe with `useStoreEvents` and re-render on the events they care about |
| [`strings.ts`](../src/ui/strings.ts) | Every user-facing string. `S` must stay free of protocol jargon (a test enforces this); `DEBUG` holds the Settings > Debug wording |
| [`theme/`](../src/ui/theme) | KaiOS metrics (header, softkey bar, list rows) with Signal's light and dark colors, switched by `data-theme` on `<html>` |

Startup ([`main.tsx`](../src/ui/main.tsx)) loads libsignal and opens the database, then shows the chats if the phone is linked, or the welcome and linking screens if not. If libsignal or the database can't load, it shows a startup error with a restart option instead.

## Receiving

```mermaid
sequenceDiagram
  participant S as chat.signal.org
  participant WS as ws.ts
  participant E as signalBridge
  participant L as libsignal wasm
  participant St as store.ts
  S->>WS: WebSocketMessage PUT /api/v1/message
  WS->>E: processIncomingEnvelope(bytes)
  E->>L: unseal and decrypt (serialized queue)
  L-->>E: Content
  E-->>WS: normalized JSON frame
  WS->>St: ingestRaw(frame) via normalize.ts
  St->>St: persist to IndexedDB
  WS->>S: 200 ACK
```

A frame is acknowledged only after it has been decrypted and stored, so a crash never loses a message. Envelopes are decrypted one at a time ([`net/client.ts`](../src/engine/net/client.ts) `enqueueDecryptEnvelope`). A message that fails to decrypt triggers a `DecryptionErrorMessage` retry receipt to the sender. After the initial offline queue drains (`/api/v1/queue/empty`), queued messages don't each raise a notification.

## Sending

`store.send*` in [`src/ui/data/store.ts`](../src/ui/data/store.ts) writes an optimistic `pending` message, then calls the engine's `signalBridge.send`. The engine:

1. Resolves the recipient to an ACI (phone numbers via synced contacts).
2. Builds the `Content` protobuf and pads it.
3. For each of the recipient's devices, establishes a session from a PreKey bundle if needed (PQXDH) and encrypts with the Double Ratchet. When the recipient's profile key is known, it wraps the result in Sealed Sender with an `Unidentified-Access-Key`.
4. Sends `PUT /v1/messages/<aci>`, and on `409`/`410` updates the device list and retries.
5. Sends a sync copy to your other devices.

Group messages use Sender Keys, following Signal-Desktop's `sendToGroup`. [`services/group-send.ts`](../src/engine/services/group-send.ts) keeps the group send endorsements that come with each `GroupResponse` (refetched when they're missing, don't cover every member, or are about to expire) and a distribution ID per group, along with the member devices that already have our `SenderKeyDistributionMessage`. A send gives that message to devices that lack it (1:1, as above), then encrypts the content once with the sender key, wraps it in multi-recipient Sealed Sender, and sends one `PUT /v1/messages/multi_recipient` with a `Group-Send-Token` built from the endorsements. A `409`/`410` fixes the device lists and retries once, members in `uuids404` are dropped, and a member who left gets a new distribution ID so they can't read later messages. Groups without endorsements, groups with fewer than two other members, and any other failure fall back to sending to each member individually; so do group-change notifications.

Pins (`DataMessage.pinMessage` / `unpinMessage`), disappearing-timer updates in 1:1 chats, and the full blocked list (`SyncMessage.Blocked`) use the same send path. Typing indicators and read receipts are not sent to blocked people, and content from blocked people and groups is dropped on receipt but still acknowledged.

## Storage Service writes

Contact nicknames, blocking, archive, mute, pinned chats, and the username are account state that Signal keeps in the encrypted [Storage Service](https://github.com/signalapp/Signal-Desktop/blob/main/protos/SignalStorage.proto). Edits go through `mutateStorage` in [`services/storage-service.ts`](../src/engine/services/storage-service.ts), following Signal-Desktop's `storage.ts`:

```mermaid
sequenceDiagram
  participant B as signalBridge
  participant Q as StorageWriteQueue
  participant SS as storage.signal.org
  participant D as Your other devices
  B->>Q: enqueue(mutations)
  Note over Q: waits 1.5 s and batches
  Q->>SS: GET /v1/storage/manifest
  Q->>SS: PUT /v1/storage/read (only keys not cached)
  Q->>Q: apply mutations, re-encrypt changed records under new random keys
  Q->>SS: PUT /v1/storage (WriteOperation, manifest version + 1)
  SS-->>Q: 409 if another device wrote first: re-read and retry (3 attempts)
  Q->>D: SyncMessage.FetchLatest(STORAGE_MANIFEST)
```

The new manifest keeps every identifier it doesn't touch, including record types this app doesn't read, and unknown protobuf fields survive the re-encode. Each pull marks the records another device wrote since the previous pull as `changed`. Archive, mute, and pinned-chat state is applied only from those records, and the store's `applyChatState` applies it without writing it back, so local and remote changes don't overwrite each other in a loop.

The username itself is claimed on the chat server first: [`services/usernames.ts`](../src/engine/services/usernames.ts) reserves one of libsignal's candidates (`PUT /v1/accounts/username_hash/reserve`) and confirms it with a zero-knowledge proof and an encrypted username link (`PUT /v1/accounts/username_hash/confirm`). Only then are the username and link written to the account record. The QR code is `https://signal.me/#eu/` followed by the link's entropy and server ID.

## Group changes

Group edits are Groups V2 changes, built and signed as in Signal-Desktop's `groups.ts`. [`services/group-changes.ts`](../src/engine/services/group-changes.ts) fetches the group, builds `GroupChange.Actions` from a snapshot of the decrypted state (title, description, timer, access control, invite link, members, roles, invites, leave), and sends `PATCH /v2/groups/` at revision + 1 with a zkgroup auth credential presentation. A `409` rebuilds the change once against the new state; a `403` becomes "you don't have permission".

The server returns the signed `GroupChange`, which the bridge sends as `DataMessage.groupV2 { masterKey, revision, groupChange }` to everyone in the group before and after the change, plus a sync copy to your other devices. Adding someone joins them directly when their profile key credential can be fetched (`GET /v1/profile/{aci}/{version}/{request}?credentialType=expiringProfileKey`), and invites them otherwise.

## Linking

```mermaid
sequenceDiagram
  participant P as KaiOS phone
  participant S as chat.signal.org
  participant M as Your main phone
  P->>S: open /v1/websocket/provisioning/
  S-->>P: provisioning address
  P->>P: show sgnl://linkdevice QR (address + ephemeral key)
  M->>P: scan QR
  M->>S: encrypted ProvisionMessage
  S-->>P: ProvisionEnvelope
  P->>P: decrypt (libsignal provisioning cipher)
  P->>S: PUT /v1/devices/link (signed and Kyber PreKeys)
  P->>S: PUT /v2/keys (one-time PreKeys)
  P->>S: request contacts, blocked, configuration, keys sync
```

This follows Signal-Desktop's linking flow ([`AccountManager`](https://github.com/signalapp/Signal-Desktop/tree/main/ts/textsecure)). Afterwards the engine pulls contacts and groups from the [Storage Service](https://github.com/signalapp/Signal-Desktop/blob/main/protos/SignalStorage.proto) and group state from `storage.signal.org/v2/groups/`.

## The libsignal wrapper

The wrapper is record-in, record-out: libsignal never touches IndexedDB directly.

```mermaid
flowchart LR
  A["protocol.ts takes the lock"] --> B["load records from IndexedDB"]
  B --> C["hydrate a ProtocolStore in wasm"]
  C --> D["one libsignal call"]
  D --> E["take changed records"]
  E --> F["write back to IndexedDB"]
  F --> G["release the lock"]
```

Every libsignal call that touches protocol state goes through [`src/engine/protocol/protocol.ts`](../src/engine/protocol/protocol.ts), which serializes these cycles. Failures come back as JS errors whose `name` is a stable code such as `UntrustedIdentity` or `DuplicatedMessage`.

| Rust module | Provides |
| --- | --- |
| `store.rs` | In-memory libsignal stores, filled with `put*` and drained with `take*` |
| `keys.rs` | Identity keys, XEdDSA, registration IDs, and PreKey, signed PreKey, and Kyber PreKey records |
| `session.rs` | PreKey bundles, encrypt and decrypt (PQXDH, SPQR), `DecryptionErrorMessage`, `PlaintextContent` |
| `sealed.rs` | Sealed Sender with SenderCertificate validation against Signal's trust roots, and multi-recipient Sealed Sender for group sends |
| `group.rs` | Sender Key distribution and group encrypt and decrypt |
| `fingerprint.rs` | Safety numbers and scannable fingerprints |
| `provisioning.rs` | The linking cipher |
| `account.rs` | Account Entropy Pool to master key, and username hashes |
| `username.rs` | Username candidates, zero-knowledge proofs, and encrypted username links |
| `zk.rs` | Profile key version, commitment, and access key; Groups V2 params, blob and member decryption, profile key encryption, auth and expiring profile key credential presentations; group send endorsements and tokens |
| `tls.rs` | TLS client for Signal's hosts with libsignal's pinned roots (see [Network](#network)) |

## Engine modules

| File | Responsibility |
| --- | --- |
| [`index.ts`](../src/engine/index.ts) | `signalBridge`: recipients, sync messages, sends, blocking, group changes, pins, usernames, chat-list state, Storage Service refresh |
| [`protocol/libsignal.ts`](../src/engine/protocol/libsignal.ts) | Loads the wasm module (`ready()`) |
| [`protocol/protocol.ts`](../src/engine/protocol/protocol.ts) | Hydrate, call, and flush around each libsignal operation; trust policy; Sealed Sender trust roots |
| [`protocol/prekeys.ts`](../src/engine/protocol/prekeys.ts) | Signed, last-resort Kyber, and one-time PreKeys |
| [`protocol/store.ts`](../src/engine/protocol/store.ts) | `SignalProtocolStore` over IndexedDB (and in memory for tests) |
| [`net/http.ts`](../src/engine/net/http.ts) | Signal hosts and the HTTP function shapes passed in from [`src/ui/data/http.ts`](../src/ui/data/http.ts) |
| [`net/proto.ts`](../src/engine/net/proto.ts) | WebSocket framing, service IDs, and delimited streams over the generated codecs |
| [`net/provisioning.ts`](../src/engine/net/provisioning.ts) | Linking, device name cipher, and the initial PreKey upload |
| [`net/receive.ts`](../src/engine/net/receive.ts) | Envelope decryption and `Content` → JSON frames; contact sync blobs |
| [`net/client.ts`](../src/engine/net/client.ts) | `SignalClient`: device fanout, Sealed Sender, retry receipts, attachment upload and download |
| [`net/transport/`](../src/engine/net/transport) | `signalBridge.net`: pinned TLS, HTTP/1.1, and WebSocket for Signal's hosts |
| [`services/storage-service.ts`](../src/engine/services/storage-service.ts) | Storage Service pull and writes (`mutateStorage`, `StorageWriteQueue`), with Signal-Desktop's key derivation |
| [`services/profiles.ts`](../src/engine/services/profiles.ts) | Versioned profile fetch and decrypt, profile upload, avatars, username lookup, expiring profile key credentials |
| [`services/groups-v2.ts`](../src/engine/services/groups-v2.ts) | zkgroup group IDs, `GroupContextV2`, group state fetch and decode, invite links |
| [`services/group-changes.ts`](../src/engine/services/group-changes.ts) | Groups V2 change builders and `applyGroupChange` |
| [`services/group-send.ts`](../src/engine/services/group-send.ts) | Group send endorsements and tokens, per-group sender key distribution IDs, and which member devices have our sender key |
| [`services/usernames.ts`](../src/engine/services/usernames.ts) | Username reserve, confirm, delete, and link URLs |
| [`crypto/`](../src/engine/crypto) | WebCrypto AES and [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) HMAC/HKDF for attachments, profiles, and storage |

## Storage

Each account has its own IndexedDB database ([`src/ui/data/db.ts`](../src/ui/data/db.ts), schema version 4), named `signal4kaios:<number>`:

| Store | Holds |
| --- | --- |
| `messages`, `conversations`, `contacts` | Chat history and the conversation list |
| `kv` | Synced contacts and groups, credentials caches, and settings |
| `attachments` | Cached decrypted media (LRU) |
| `signal_keystore`, `signal_identities`, `signal_sessions`, `signal_prekeys`, `signal_sender_keys` | Serialized libsignal records and remote identity keys |

Upgrading from a database older than version 4 discards the protocol state and asks you to link again. The database is named after the account's number, which isn't known until the `ProvisionMessage` arrives, so linking switches to the new account's database (`db.useAccount`) before it saves any keys.

## Security model

- **Keys stay on the phone.** Identity keys and sessions live only in IndexedDB, and the device password only in the app's `localStorage`. 2.0.x also cached the login for the ServiceWorker; 2.1.0 deletes that copy on upgrade.
- **Untrusted input.** WebSocket frames, protobufs, and HTTP responses are all parsed defensively; a bad frame is logged and dropped.
- **Sync messages** are accepted only from our own ACI. Recipients must be ACIs.
- **Identity changes.** A contact's first identity key is trusted on first use. If it later changes, the contact drops to untrusted, and if you had verified them, sending stops until you review the new safety number.
- **Sealed Sender** certificates are checked against Signal's production trust roots.
- **TLS.** Connections to Signal's hosts trust only the two roots libsignal pins, not the phone's certificate store, so a CA added to the phone can't intercept them. The one exception is opt-in: once the phone trusts Signal's root, attachment CDN transfers use the platform's TLS, whose contents are end-to-end encrypted and MAC-checked ([Network](#network)).
- **CSP.** The privileged-app CSP forbids `eval`, `new Function`, and inline scripts, and `scripts/package.sh` fails the build if any shipped script contains them.
- **Screen lock** ([`src/ui/data/screen-lock.ts`](../src/ui/data/screen-lock.ts)) keeps only a salted PBKDF2-SHA-256 hash of the PIN in `s4k.config`, and the wrong-PIN count, so a restart doesn't reset the wait. It covers the UI and nothing else: the databases aren't encrypted with the PIN. The PIN is read from the keypad's digit keys with no text field focused, so the keyboard never sees it.
- **Profile key.** Only the primary phone rotates the profile key; Signal-Desktop as a linked device doesn't either. A Storage Service pull whose `AccountRecord.profileKey` differs from ours replaces the account's key and drops our cached credential for the old one.
- **Logs.** The debug log never records keys, passwords, or provisioning codes. Everyday screens show plain-language errors (`friendlyError` in [`src/ui/errors.ts`](../src/ui/errors.ts)); the technical detail goes only to the log, which Settings > Debug shows.
