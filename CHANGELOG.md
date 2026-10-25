# Changelog

Each `## v<version>` section becomes the notes of that GitHub Release; the release workflow fails if the tag has no section here.

## Unreleased

### Removed

- The OStore source at `ambercaravalho.github.io/signal4kaios`. Current OStore builds can't add custom sources, so it couldn't be used. On KaiOS 3.0+, install and update by copying the ZIP from Releases to the phone and using OStore's **Manual Install** tab → **Install app from sdcard** (see [Setup](https://github.com/ambercaravalho/signal4kaios/blob/main/docs/setup.md#3-install-the-app)).

## v1.1.1

The backend is easier to run: the gateway now ships as a prebuilt image. The phone app is unchanged.

### Gateway

- The gateway is now a prebuilt image, `ghcr.io/ambercaravalho/signal4kaios-gateway`, for x86-64 and 64-bit ARM (e.g. Raspberry Pi). `docker compose up` pulls it instead of building it, so starting and updating the backend no longer needs a compiler or a long local build (see [Setup](https://github.com/ambercaravalho/signal4kaios/blob/main/docs/setup.md)).
- The gateway runs on Node 26, with its dependencies updated.

### Upgrading

- In your checkout: `git pull`, then `docker compose -f docker/docker-compose.yml pull` and `docker compose -f docker/docker-compose.yml up -d`. Your linked Signal account and paired phones carry over.

## v1.1.0

Pairing replaces reverse-proxy authentication. Setting up a phone is now two fields: the gateway's address and a one-time code.

### Pairing

- On first start, the gateway prints an 8-digit pairing code to its log. Enter it in the app along with the gateway's address; the app fetches your Signal number from the backend, and lets you pick one if several are linked.
- Codes expire after 15 minutes, work once, and are burned after 5 wrong tries. Pairing attempts are rate-limited per address.
- Every request from the app now carries a per-phone token. The gateway rejects anything unpaired, so it is safe to expose without an authenticating proxy; a reverse proxy is only needed for HTTPS.
- Manage phones from the gateway: `npm run pair` prints a new code, `npm run devices` lists paired phones, and `npm run revoke <id>` unpairs one, which also stops its push notifications and drops its live connection.
- Unpair a phone from the app in Settings → Gateway and pairing. If the gateway stops recognizing a phone, the app returns to the pairing screen and explains why.

### Removed

- The Basic and token connection-security modes, and their settings. The app no longer talks to signal-cli-rest-api directly; the gateway is required.

### Docs

- Setup is now a single guide, [docs/setup.md](https://github.com/ambercaravalho/signal4kaios/blob/main/docs/setup.md), covering the backend, linking your Signal account, installing, pairing, and use away from home.

### Upgrading from v1.0.0-rc1

- Update the gateway together with the app; v1.1.0 phones can't use an rc1 gateway, and the reverse.
- The gateway's database changed without a migration. Delete the `gateway-data` volume before starting the new gateway (buffered messages are only a short reconnect backlog; your message history lives on the phone).
- Remove any authentication you configured on your reverse proxy, then pair the phone with the code from the gateway log.

## v1.0.0-rc1

First public pre-release, for testing the OStore install and update path.

- Real-time 1:1 and group chat with reactions, replies, edits, mentions, text formatting, read receipts, and typing indicators.
- Disappearing messages with a live countdown, pinned messages, and group management (members, admins, permissions, invite links).
- Photos, video, voice notes, and files through the KaiOS file picker, with inline thumbnails and in-app playback.
- Background push notifications that arrive with the app fully closed, and a gateway that buffers messages while the phone is offline.
- Multiple accounts, archived and muted chats, pinned conversations, local message search, and a light or Signal-dark theme.
- One package for KaiOS 2.5, 3.0, 3.1, and 4.0, with a first-run guide explaining the self-hosted backend.
- Connections are secured by a reverse proxy in front of the gateway (none, Basic, or token modes).
