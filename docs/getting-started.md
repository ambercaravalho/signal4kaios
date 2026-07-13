# Getting started

This walks you from nothing to a working Signal client on your phone. There are
three parts: the **server**, the **install**, and the **first-run config**.

- [Requirements](#requirements)
- [1. The server: signal-cli-rest-api](#1-the-server-signal-cli-rest-api)
- [2. Install (sideload)](#2-install-sideload)
- [3. First-run configuration](#3-first-run-configuration)
- [Next steps](#next-steps)

## Requirements

- A phone running **KaiOS 2.5** (Gecko 48) with the developer/debug menu
  enabled.
- A **signal-cli-rest-api** server running in **`json-rpc`** mode
  (`MODE=json-rpc`), already **registered or linked** to your Signal account,
  and **reachable from the phone**:
  - directly on your Wi-Fi (e.g. `http://192.168.1.100:4329`), or
  - through a reverse proxy for access away from home — see
    [Remote access](remote-access.md).
- A desktop with **ADB** and an old **Firefox (52–59)** for WebIDE, used once to
  sideload the app.

> Why json-rpc mode? The app receives messages in real time over the
> `/v1/receive` WebSocket, which signal-cli-rest-api only exposes in `json-rpc`
> mode. In `normal` mode there is no live socket and messages won't stream in.

## 1. The server: signal-cli-rest-api

signal4kaios is only a client — your Signal account lives on the server. If you
don't already have one running, follow the upstream project:
[bbernhard/signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api).

The essentials the app depends on:

- Run the container with **`MODE=json-rpc`**.
- **Register** a new number or **link** the server as a secondary device to an
  existing Signal account (linking is usually easiest — the server appears as a
  linked device, like Signal Desktop).
- Make sure the server's HTTP port is reachable from the phone. On the same
  Wi-Fi that's just the LAN IP and port (e.g. `http://192.168.1.100:4329`).

You can sanity-check the server from any browser on the same network by opening
`http://<server>:<port>/v1/about` — it should return JSON including the version
and `"mode": "json-rpc"`. The app's **Test connection** button hits this same
endpoint.

## 2. Install (sideload)

1. On your desktop, package the app (or point WebIDE at the `app/` folder
   directly):

   ```sh
   sh tools/package.sh
   ```

   This checks for Gecko-48-incompatible syntax and produces
   `dist/signal4kaios.zip`.

2. On the phone, enable debug mode by dialing:

   ```
   *#*#33284#*#*
   ```

   A small bug icon appears in the status bar when it's on.

3. Connect the phone over USB and forward the debugger socket:

   ```sh
   adb forward tcp:6000 localfilesystem:/data/local/debugger-socket
   ```

4. In an old **Firefox (52–59)**, open **WebIDE** → **Remote Runtime** →
   `localhost:6000`.

5. Choose **Open Packaged App**, select the **`app/`** folder, then
   **Install and Run**.

> **Re-sideload after updates that change `manifest.webapp` permissions**, or
> the new permissions won't take effect. See
> [what permissions the app requests](#permissions).

### Permissions

The app is a **privileged** app and declares these permissions in
[`app/manifest.webapp`](../app/manifest.webapp):

| Permission | Why |
|---|---|
| `systemXHR` | Talk to the signal-cli-rest-api server cross-origin without CORS |
| `desktop-notification` | Notify you of new messages when the app is backgrounded |
| `alarms` | Wake periodically to reconnect the WebSocket and catch up |
| `video-capture` | Use the camera (getUserMedia) to scan a Signal QR code |
| `device-storage:pictures` | Save received photos to the gallery |
| `device-storage:music` | Save received voice messages and audio |
| `device-storage:videos` | Save received videos |
| `device-storage:sdcard` | Save received files |

## 3. First-run configuration

The first launch opens **Settings** automatically. Fill in:

- **Server URL** — e.g. `http://192.168.1.100:4329` (or your public
  `https://` address if using a reverse proxy).
- **My Signal number** — in E.164 form, e.g. `+15551234567`. The app normalizes
  spaces, parentheses, and dashes and adds a leading `+` if you forget it.
- **Reverse proxy username / password** — leave blank unless your server is
  behind HTTP Basic Auth. See [Remote access](remote-access.md).
- **Receive token** (optional) — a Pangolin Resource Access Token
  (`<id>.<secret>`) the app appends to the `/v1/receive` WebSocket URL as
  `?p_token=` so the proxy can authenticate live updates (Basic Auth can't cover
  a browser WebSocket). Leave blank on a LAN/tunnel. See
  [Remote access](remote-access.md#authenticating-the-receive-path-with-a-token-recommended).

Then:

1. Press **Test connection** to confirm the server is reachable. A success line
   shows the server version and mode.
2. Press **Save**. The app stores the settings, reconnects the WebSocket, and
   loads your contacts and groups.

After that you land on the conversation list. History builds up from this point
forward (there's no server-side history to import).

Got more than one Signal number? You can add and switch between accounts later
from **Settings → Accounts** — each keeps its own local history on the phone.

## Next steps

- Learn the app: **[User guide](user-guide.md)**.
- Use it away from home: **[Remote access](remote-access.md)**.
- If something doesn't work: **[Troubleshooting](README.md#troubleshooting)**.
