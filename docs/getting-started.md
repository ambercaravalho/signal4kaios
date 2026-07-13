# Getting started

From nothing to a working Signal client on your phone, in three parts: the
**server**, the **install**, and the **first-run config**.

- [Requirements](#requirements)
- [1. The server](#1-the-server)
- [2. Install (sideload)](#2-install-sideload)
- [3. First-run configuration](#3-first-run-configuration)
- [Next steps](#next-steps)

## Requirements

- A phone running **KaiOS 2.5** (Gecko 48) with the developer/debug menu enabled.
- A **signal-cli-rest-api** server in **`json-rpc`** mode (`MODE=json-rpc`),
  already **registered or linked** to your account, and **reachable from the
  phone** — directly on Wi-Fi (e.g. `http://192.168.1.100:4329`) or through a
  reverse proxy (see [Remote access](remote-access.md)).
- A desktop with **ADB** and an old **Firefox (52–59)** for WebIDE, used once to
  sideload.

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

1. Package the app (or point WebIDE at `app/` directly):

   ```sh
   sh tools/package.sh
   ```

   This checks for Gecko-48-incompatible syntax and produces
   `dist/signal4kaios.zip`.

2. On the phone, enable debug mode by dialing `*#*#33284#*#*` (a bug icon
   appears in the status bar).

3. Connect over USB and forward the debugger socket:

   ```sh
   adb forward tcp:6000 localfilesystem:/data/local/debugger-socket
   ```

4. In **Firefox (52–59)**, open **WebIDE → Remote Runtime → `localhost:6000`**.

5. Choose **Open Packaged App**, select the **`app/`** folder, then **Install
   and Run**.

> **Re-sideload after any change to `manifest.webapp` permissions**, or they
> won't take effect.

### Permissions

The app is **privileged** and declares these in
[`app/manifest.webapp`](../app/manifest.webapp):

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
