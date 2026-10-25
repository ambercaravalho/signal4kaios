# Setup

From nothing to Signal on your KaiOS phone. You'll need a computer or server that can run Docker (home PC, Raspberry Pi, or VPS) and a phone running KaiOS 2.5, 3.0, 3.1, or 4.0.

1. [Start the backend](#1-start-the-backend)
2. [Link your Signal account](#2-link-your-signal-account)
3. [Install the app](#3-install-the-app)
4. [Pair the phone](#4-pair-the-phone)

Also: [Using it away from home](#using-it-away-from-home) · [Managing paired phones](#managing-paired-phones) · [Troubleshooting](#troubleshooting)

## 1. Start the backend

The backend is two containers: **signal-cli-rest-api**, which holds your Signal account, and the **gateway**, which is the only thing the phone talks to. Both are prebuilt images (the gateway is published to `ghcr.io/ambercaravalho/signal4kaios-gateway` for x86-64 and 64-bit ARM such as a Raspberry Pi), so nothing is built on your machine:

```sh
git clone --depth 1 https://github.com/ambercaravalho/signal4kaios.git
cd signal4kaios
cp docker/.env.example docker/.env
docker compose -f docker/docker-compose.yml up -d
```

Run the `docker compose` commands in this guide from the `signal4kaios` folder. The gateway listens on port **8090**. For notifications with the message text (not just "New message"), set a VAPID key pair in `docker/.env` before starting: generate one with `npx web-push generate-vapid-keys`.

To update later, pull the repo and the new images, then recreate the containers:

```sh
git pull
docker compose -f docker/docker-compose.yml pull
docker compose -f docker/docker-compose.yml up -d
```

## 2. Link your Signal account

Link the backend to your Signal account as a linked device, the same way you'd add Signal Desktop. This is a one-time step:

1. In `docker/docker-compose.yml`, uncomment the `ports` lines under `signal-cli-rest-api` (they publish its API on `localhost` only) and run `docker compose -f docker/docker-compose.yml up -d` again.
2. On the same computer, open `http://localhost:8080/v1/qrcodelink?device_name=signal4kaios`.
3. In Signal on your main phone, go to **Settings → Linked devices → Link a new device** and scan the QR code.
4. Comment the `ports` lines out again and re-run `up -d`.

To register a number directly instead of linking, see [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api).

## 3. Install the app

Download the ZIP from [Releases](https://github.com/ambercaravalho/signal4kaios/releases), or build one with `sh app/scripts/package.sh`.

**KaiOS 3.0, 3.1, 4.0 — with OStore (easiest).** Copy the ZIP, as-is (don't unzip it), onto the phone's storage, over USB or by downloading it on the phone. In OStore, open the **Manual Install** tab, choose **Install app from sdcard**, and pick the ZIP. To update, repeat with the newer ZIP.

**Sideloading from a computer (any version).** Unzip the ZIP. Enable the phone's debug mode (on 2.5, dial `*#*#33284#*#*`), connect it over USB, then:

- **KaiOS 2.5:** `adb forward tcp:6000 localfilesystem:/data/local/debugger-socket`, open WebIDE in Firefox 52–59, connect to the remote runtime at `localhost:6000`, and use **Open Packaged App** on the `app/` folder.
- **KaiOS 3.0+:** get [`appscmd`](https://github.com/kaiostech/appscmd) and run `APPSCMD=/path/to/appscmd sh app/scripts/install-kaios3plus.sh`, then reboot the phone.

## 4. Pair the phone

When the gateway first starts, it prints a one-time **pairing code** to its log:

```sh
docker compose -f docker/docker-compose.yml logs gateway
```

```text
  Signal4KaiOS pairing code:  1234-5678
```

Open the app, read the short welcome, press **Set up**, and enter:

- **Gateway address:** e.g. `http://192.168.1.100:8090` (the computer's address on your network), or your `https://` address if you've set one up.
- **Pairing code:** the 8 digits.

Press **Pair**. The phone receives its own credential and your Signal number from the backend (if the backend has several numbers, pick one). The code works once and expires after 15 minutes. To get a new one:

```sh
docker compose -f docker/docker-compose.yml exec gateway npm run pair
```

History builds from here on; Signal has no server-side history for the app to import. To add another number from the same backend, use **Settings → Switch account → Add account** with the same gateway address (no code needed).

## Using it away from home

On your home Wi-Fi, `http://<computer>:8090` is all you need. Anyone on that network who can watch traffic could see the pairing code and the phone's credential, so use HTTPS for anything outside a network you trust.

To reach the gateway from anywhere, put HTTPS in front of port 8090. Any reverse proxy works (Caddy, nginx, Traefik, a Cloudflare Tunnel), or a VPN such as Tailscale or WireGuard. The proxy needs no login or auth settings, because the gateway checks the paired credential on every request itself. It must pass WebSocket upgrades through on `/v1/receive/...`. Then pair (or pair again) using the `https://` address.

## Managing paired phones

```sh
docker compose -f docker/docker-compose.yml exec gateway npm run devices   # list
docker compose -f docker/docker-compose.yml exec gateway npm run revoke 3  # unpair device 3
```

A revoked phone is disconnected within a minute, stops receiving notifications, and shows the pairing screen next time it connects. On the phone itself, **Settings → Server & connection → Unpair this phone** does the same.

## Troubleshooting

Start with **Settings → Debug log** on the phone: it records network errors, WebSocket connects and closes, and unrecognized message shapes.

- **"Cannot reach the gateway."** Check the address and port, that both containers are running (`docker compose -f docker/docker-compose.yml ps`), and that the phone is on the same network (or that your HTTPS address works from a browser).
- **"Wrong or expired pairing code."** Codes last 15 minutes and work once. Five wrong tries burn a code. Get a new one with `npm run pair`.
- **"Paired, but no Signal account is linked."** Finish [step 2](#2-link-your-signal-account), then press **Pair** again; no new code is needed.
- **"HTTP 502" or the gateway is up but nothing loads.** signal-cli-rest-api isn't responding; check its container log.
- **The app went back to the pairing screen.** The gateway no longer recognizes this phone: it was revoked, or the gateway's data volume was reset. Pair again with a new code.
- **Notifications say only "New message".** Set VAPID keys (see [step 1](#1-start-the-backend)) and restart the gateway.
- **Live messages don't arrive through a reverse proxy.** The proxy isn't passing WebSocket upgrades on `/v1/receive/...`.
- **Old messages are missing.** Expected: history only exists from when you started using the app, and the gateway replays at most the last 500 messages you missed while offline.
