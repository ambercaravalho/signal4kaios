# Setup

From nothing to Signal on your KaiOS 3.0, 3.1, or 4.0 phone. In v2.0.0, **no computer, Docker container, or gateway server is needed** — all Signal encryption and decryption happen directly on the phone.

1. [Install the app](#1-install-the-app)
2. [Link your Signal account](#2-link-your-signal-account)
3. [Syncing contacts and groups](#3-syncing-contacts-and-groups)
4. [Troubleshooting](#4-troubleshooting)
- [KaiOS 4.0: enable WebAssembly](#kaios-40-enable-webassembly)

## 1. Install the app

Download `signal4kaios-2.0.0.zip` from [Releases](https://github.com/ambercaravalho/signal4kaios/releases), or build one locally with `npm install && npm run package`.

**With OStore (easiest, no computer needed).** Copy the ZIP as-is (do not unzip it) onto the phone's storage or SD card. In OStore, open the **Manual Install** tab, choose **Install app from sdcard**, and pick the ZIP. To update later, repeat with the newer ZIP.

**Sideloading over USB with `appscmd`.** Enable debug mode on the phone, connect it over USB, get [`appscmd`](https://github.com/kaiostech/appscmd), and run:

```sh
APPSCMD=/path/to/appscmd sh app/scripts/install-kaios3plus.sh
```

On **KaiOS 4.0**, also do the one-time [enable WebAssembly](#kaios-40-enable-webassembly) step before first launch.

## 2. Link your Signal account

Signal4KaiOS links to your existing Signal account as a linked device, just like Signal Desktop:

1. Open **Signal4KaiOS** on your KaiOS phone and step through the Welcome screen to **Link with Signal**.
2. The phone connects to Signal's provisioning service and displays a QR code on screen.
3. On your main phone, open Signal and go to **Settings → Linked devices → Link a new device**.
4. Scan the QR code displayed on your KaiOS phone.

Once scanned, your KaiOS phone decrypts the provisioning envelope, generates and uploads its own encryption PreKeys to Signal, and opens the conversation list.

## 3. Syncing contacts and groups

Right after linking, Signal4KaiOS asks your main phone for your contacts, blocked list, settings, and account keys, and reads your contacts and groups from Signal's encrypted Storage Service. Keep Signal open on your main phone for a moment so it can answer. Group names and member lists are then fetched from Signal's group server, so a group may show as "Group" for a few seconds the first time.

You can trigger a fresh sync at any time from **Settings → Linked account → Sync contacts & groups** or **Settings → Refresh contacts & groups**.

## 4. Troubleshooting

Start with **Settings → Debug log** on the phone: it records WebSocket connection state, PreKey status, and decryption diagnostics.

- **QR code does not appear on the Link screen.** Check that your phone has an active Wi-Fi or mobile data connection, then press **SoftRight (Refresh QR)** or select **Generate QR code**.
- **The app returned to the Link screen.** Your KaiOS device was unlinked from your main phone (in Signal → Settings → Linked devices), or you updated from an earlier v2.0.0 build whose encryption state is not compatible with the official libsignal engine. Scan the QR code to link again.
- **"Cannot start" screen on KaiOS 4.0.** WebAssembly is blocked by the system content security policy; follow [KaiOS 4.0: enable WebAssembly](#kaios-40-enable-webassembly).
- **Contacts or group names show as numbers or UUIDs.** Open **Settings → Linked account → Sync contacts & groups** while your main phone is online.
- **Old messages from before linking are missing.** Expected: Signal does not store message history on its servers, so history on a linked device accrues from the moment it is linked. Messages sent to you while the KaiOS phone is turned off are queued by Signal's servers and delivered when you open the app.

## KaiOS 4.0: enable WebAssembly

Signal4KaiOS runs Signal's official encryption library ([libsignal](https://github.com/signalapp/libsignal)) as WebAssembly. KaiOS 3.0 and 3.1 allow this out of the box. KaiOS 4.0 serves apps through `api-daemon` with a content security policy that has no `'wasm-unsafe-eval'`, so the app shows a **Cannot start** screen until you allow it. Installing third-party privileged apps on KaiOS 4.0 already needs a rooted phone, and the same root access is what this step uses.

1. Connect the phone over USB with debugging enabled and open a root shell: `adb root` (or `adb shell` then `su`).
2. Find the active config: `adb shell ps -A | grep api-daemon` shows the path the daemon was started with. On most builds it is `/system/api-daemon/config.toml`; some builds keep an updatable copy under `/data/local/service/api-daemon/config.toml`.
3. Pull it: `adb pull /system/api-daemon/config.toml`.
4. In the `[vhost]` section, add `'wasm-unsafe-eval'` to the `script-src` list of the `csp` value. Leave everything else as it is. For example, `script-src 'self' http://127.0.0.1 http://shared.localhost;` becomes `script-src 'self' 'wasm-unsafe-eval' http://127.0.0.1 http://shared.localhost;`.
5. Push it back: `adb shell mount -o remount,rw /system`, then `adb push config.toml /system/api-daemon/config.toml`, then `adb shell mount -o remount,ro /system`.
6. Reboot the phone and open Signal4KaiOS.

`'wasm-unsafe-eval'` only permits compiling WebAssembly; it does not re-enable JavaScript `eval`, and the app's own manifest CSP still forbids inline scripts. A system update may restore the original config, in which case repeat these steps.
