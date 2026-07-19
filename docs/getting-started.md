# Getting started

From nothing to a working Signal client on your phone, in three parts: the
**server**, the **install**, and the **first-run config**.

- [Requirements](#requirements)
- [1. The server](#1-the-server)
- [2. Install (sideload)](#2-install-sideload)
- [3. First-run configuration](#3-first-run-configuration)
- [Next steps](#next-steps)

## Requirements

- A phone running **KaiOS 2.5** (Gecko 48), **3.0/3.1** (Gecko 84), or **4.0**
  (Gecko 123) with the developer/debug menu enabled. The app ships one package
  that installs on all of them; only the install tool differs (see below).
- A **signal-cli-rest-api** server in **`json-rpc`** mode (`MODE=json-rpc`),
  already **registered or linked** to your account, and **reachable from the
  phone** — directly on Wi-Fi (e.g. `http://192.168.1.100:4329`) or through a
  reverse proxy (see [Remote access](remote-access.md)).
- A desktop with **ADB**, plus:
  - **KaiOS 2.5** — an old **Firefox (52–59)** for WebIDE.
  - **KaiOS 3.0/3.1/4.0** — the **`appscmd`** tool (WebIDE is gone) and a modern
    **Firefox** for `about:debugging`. Note: on-device debugging is only
    available on 3.0/3.1/4.0 builds that have it enabled.

> Why `json-rpc`? The app receives messages in real time over the `/v1/receive`
> WebSocket, which the server only exposes in `json-rpc` mode. In `normal` mode
> there is no live socket.

## 1. The server

signal4kaios is only a client — your Signal account lives on the server. If you
don't have one running, follow
[bbernhard/signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api).
The essentials the app depends on:

- Run the container with **`MODE=json-rpc`**.
- **Register** a new number or **link** the server to an existing account
  (linking is usually easiest — it appears as a linked device, like Signal
  Desktop).
- Make the server's HTTP port reachable from the phone (on the same Wi-Fi, just
  the LAN IP and port).

Sanity-check it from any browser on the network: `http://<server>:<port>/v1/about`
should return JSON with the version and `"mode": "json-rpc"`. The app's **Test
connection** button hits the same endpoint.

## 2. Install (sideload)

First, package the app:

```sh
sh tools/package.sh
```

This checks for Gecko-48-incompatible syntax, verifies both manifests
(`manifest.webapp` for 2.5 and `manifest.webmanifest` for 3.0/3.1/4.0) and the
ServiceWorker are present, and produces `dist/signal4kaios.zip`.

### On KaiOS 2.5

1. On the phone, enable debug mode by dialing `*#*#33284#*#*` (a bug icon
   appears in the status bar).

2. Connect over USB and forward the debugger socket:

   ```sh
   adb forward tcp:6000 localfilesystem:/data/local/debugger-socket
   ```

3. In **Firefox (52–59)**, open **WebIDE → Remote Runtime → `localhost:6000`**.

4. Choose **Open Packaged App**, select the **`app/`** folder, then **Install
   and Run**.

### On KaiOS 3.0, 3.1, and 4.0

WebIDE no longer works — packaged apps install with **`appscmd`** over the
adb-forwarded debugger socket. Download the binary for your desktop from
[kaiostech/appscmd](https://github.com/kaiostech/appscmd) (e.g.
`appscmd-aarch64-apple-darwin` for Apple Silicon, `appscmd-x86_64-unknown-linux-gnu`
for Linux), make it executable, then:

```sh
APPSCMD=/path/to/appscmd sh tools/install-kaios3plus.sh
```

The helper runs `adb root`, forwards the debugger socket, and installs `app/`.
Launch it from the phone's app list, or from the desktop with
`appscmd launch http://signal4kaios.localhost/manifest.webmanifest` (the `launch`
subcommand wants the full manifest URL, not the short name). Debug with a modern
Firefox at **`about:debugging`** (not the 2.5 WebIDE).

> **Re-install after any change to manifest permissions**, or they won't take
> effect. On 3.0/3.1/4.0 the origin is `http://signal4kaios.localhost`, so a
> fresh install starts with empty settings and message history — this is
> expected.

### Permissions

The app is **privileged** and declares these in
[`app/manifest.webapp`](../app/manifest.webapp) (2.5) and the `b2g_features`
section of [`app/manifest.webmanifest`](../app/manifest.webmanifest) (3.0/3.1/4.0):

| Permission | Why |
|---|---|
| `systemXHR` | Talk to the server cross-origin without CORS |
| `desktop-notification` | Notify on new messages when backgrounded |
| `alarms` | Wake periodically to reconnect the WebSocket |
| `video-capture` | Use the camera (getUserMedia) to scan a QR code |
| `device-storage:pictures` | Save received photos to the gallery |
| `device-storage:music` | Save received voice messages and audio |
| `device-storage:videos` | Save received videos |
| `device-storage:sdcard` | Save received files |

## 3. First-run configuration

The first launch opens **Settings**. Fill in:

- **Server URL** — e.g. `http://192.168.1.100:4329` (or your public `https://`
  address behind a reverse proxy).
- **My Signal number** — E.164 form, e.g. `+15551234567` (the app normalizes
  spaces/parentheses/dashes and adds a leading `+`).
- **Reverse proxy username / password** — blank unless behind Basic Auth (see
  [Remote access](remote-access.md)).
- **Receive token** (optional) — a Pangolin Resource Access Token
  (`<id>.<secret>`) the app appends as `?p_token=` so the proxy can authenticate
  live updates (Basic Auth can't cover a browser WebSocket). Blank on a
  LAN/tunnel. See
  [Remote access](remote-access.md#authenticating-the-receive-path-with-a-token).

Then press **Test connection** (a success line shows the server version and
mode), then **Save**. The app stores the settings, connects, and loads your
contacts and groups. History builds from here forward — there's no server-side
history to import.

Got more than one number? Add and switch accounts later from **Settings →
Accounts**; each keeps its own local history.

## Next steps

- Learn the app: **[User guide](user-guide.md)**.
- Use it away from home: **[Remote access](remote-access.md)**.
- Something not working? **[Troubleshooting](user-guide.md#troubleshooting)**.
