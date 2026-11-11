# Setup

Install Beacon on a KaiOS 3.0, 3.1, or 4.0 phone and link it to your Signal account. The phone does all Signal encryption itself; nothing else needs to run.

- [Requirements](#requirements)
- [1. Install the app](#1-install-the-app)
- [2. Link your Signal account](#2-link-your-signal-account)
- [3. Contacts and groups sync](#3-contacts-and-groups-sync)
- [KaiOS 4.0: enable WebAssembly](#kaios-40-enable-webassembly)
- [Optional for rooted phones: trust Signal's certificate](#optional-for-rooted-phones-trust-signals-certificate)
- [Troubleshooting](#troubleshooting)

> [!NOTE]
> Some Signal features, such as voice calls, aren't supported yet, and video calls, stories, and payments won't be. See [Known limitations](user-guide.md#known-limitations) and the [roadmap](https://github.com/ambercaravalho/signal4kaios/issues?q=is%3Aissue%20state%3Aopen%20label%3Aroadmap) before you rely on the app.

## Requirements

| | |
| --- | --- |
| **Phone** | KaiOS 3.0, 3.1, or 4.0 with Wi-Fi or mobile data |
| **Signal account** | An existing account on a primary phone (Android or iPhone) to link from |
| **KaiOS 4.0 only** | Root access, which installing third-party privileged apps already needs |

## 1. Install the app

Download `signal4kaios-<version>.zip` from [Releases](https://github.com/ambercaravalho/signal4kaios/releases), or [build it yourself](development.md#build-and-test).

**OStore (no computer).** Copy the ZIP as-is (don't unzip it) to the phone's storage or SD card, then in OStore open **Manual Install → Install app from sdcard** and pick it. To update, repeat with the newer ZIP.

**Sideload over USB.** Enable debugging on the phone, install [adb](https://developer.android.com/tools/adb) and [`appscmd`](https://github.com/kaiostech/appscmd), and from a checkout of this repo run:

```sh
APPSCMD=/path/to/appscmd sh scripts/install.sh
```

> [!IMPORTANT]
> On KaiOS 4.0, do the [WebAssembly step](#kaios-40-enable-webassembly) before the first launch.

## 2. Link your Signal account

1. Open **Beacon** and press **Start** on the welcome screen. The phone shows a QR code.
2. On your main phone, open Signal → **Settings → Linked devices → Link a new device** ([Signal's guide](https://support.signal.org/hc/en-us/articles/360007320551)).
3. Scan the QR code on the KaiOS screen.

The KaiOS phone then finishes linking and opens your chats.

## 3. Contacts and groups sync

Right after linking, the app asks your main phone for contacts, the blocked list, settings, and account keys, then reads contacts and groups from Signal's encrypted Storage Service. Keep Signal open on the main phone for a moment. Group names and members come from Signal's group server, so a group can show as "Group" for a few seconds the first time.

To sync again later, use **Settings → Linked device → Sync with your phone**.

## KaiOS 4.0: enable WebAssembly

KaiOS 4.0 serves apps through [`api-daemon`](https://github.com/kaiostech/api-daemon), whose content security policy has no `'wasm-unsafe-eval'`, so the app shows a **Beacon couldn't start** screen until you allow WebAssembly. KaiOS 3.0 and 3.1 need nothing.

> [!WARNING]
> This edits a system file on a rooted phone. Keep a copy of the original, and expect a system update to undo it.

1. Connect the phone with debugging enabled and get a root shell: `adb root`, or `adb shell` then `su`.
2. Find the config the daemon uses: `adb shell ps -A | grep api-daemon`. It is usually `/system/api-daemon/config.toml`; some builds use `/data/local/service/api-daemon/config.toml`.
3. Pull it: `adb pull /system/api-daemon/config.toml`.
4. In the `[vhost]` section, add `'wasm-unsafe-eval'` to `script-src` in the `csp` value and change nothing else:

   ```diff
   - csp = "default-src * data: blob:; script-src 'self' http://127.0.0.1 http://shared.localhost; ..."
   + csp = "default-src * data: blob:; script-src 'self' 'wasm-unsafe-eval' http://127.0.0.1 http://shared.localhost; ..."
   ```

5. Push it back:

   ```sh
   adb shell mount -o remount,rw /system
   adb push config.toml /system/api-daemon/config.toml
   adb shell mount -o remount,ro /system
   ```

6. Reboot and open Beacon.

> [!NOTE]
> `'wasm-unsafe-eval'` only allows compiling WebAssembly. It does not allow JavaScript `eval`, and the app's own CSP still forbids inline scripts.

## Optional for rooted phones: trust Signal's certificate

Signal's servers use certificates from Signal's own root, which KaiOS doesn't trust, so Beacon normally runs TLS itself in WebAssembly. If you add Signal's root to the phone's trusted certificates, Beacon sends and receives photos, video, voice notes, and files over the phone's built-in TLS instead, which moves the encryption work out of the app. Messages, sign-in, sync, and linking stay on Beacon's own connection, which trusts only Signal's certificates.

The gain is modest. On a TCL T440W with KaiOS 4.0, downloading 1.2 MB of attachment-sized files six at a time blocked Beacon for a quarter to half as long (0.03 to 0.27 seconds instead of 0.13 to 0.86), so the app stays more responsive while media loads. Download times varied with the network: sometimes faster, sometimes about the same, and no faster for files fetched one at a time.

> [!NOTE]
> This doesn't bring notifications while Beacon is closed. Signal only delivers messages to a connection that sends a sign-in header, and only Beacon's own connection can send one. Tested on KaiOS 4.0: credentials in the address are ignored, a closed app's background worker is blocked from sending the header, and Signal has no other way to fetch messages.

> [!WARNING]
> Every app and web page on the phone will then trust certificates from Signal's root, and Beacon's photo and file transfers accept any certificate the phone trusts, not only Signal's. Their contents stay end-to-end encrypted and are checked on arrival, so a forged server can make a download fail but can't read or change it.

You need a rooted phone with **ADB and DevTools** enabled, [adb](https://developer.android.com/tools/adb), [Node.js](https://nodejs.org) 22 or newer, and a checkout of this repo. The script has been tested on KaiOS 4.0.

1. Connect the phone over USB.
2. Run:

   ```sh
   node scripts/signal-cert.mjs install
   ```

   The script backs up the phone's certificate database to `dist/cert-backups/<time>/`, then has the phone's own Gecko add Signal's root (`src/native/libsignal-wasm/res/signal.cer`) as trusted for TLS servers. No restart is needed.
3. In Beacon, open **Settings → Debug → Faster connection** and choose **Check again**. **Status** shows **On**.

`node scripts/signal-cert.mjs status` reports whether the certificate is installed. To undo, run `node scripts/signal-cert.mjs remove`, or `node scripts/signal-cert.mjs restore dist/cert-backups/<time>` to put a backup back (this restarts the phone's interface). Beacon notices the change and goes back to its own TLS for everything; nothing else changes.

<details>
<summary><strong>Why the script doesn't use certutil</strong></summary>

A desktop `certutil` from a current NSS (3.133 on macOS Homebrew, for example) writes trust settings that KaiOS 4.0's NSS 3.97 discards the next time the phone starts, so the certificate stays but isn't trusted. The script instead runs `nsIX509CertDB` inside the phone's main process over the debugger connection, so the phone's own NSS records the trust.

</details>

## Troubleshooting

Start with **Settings → Debug**: it shows the connection state, PreKey status, and the debug log, which records decryption errors but never keys or passwords. **Share log** sends a copy with your number and account IDs shortened.

<details>
<summary><strong>No QR code on the Link screen</strong></summary>

Check that the phone is online, then press **Retry**, or open **Options → Get a new code**.

</details>

<details>
<summary><strong>The app went back to the Link screen</strong></summary>

The phone was removed under **Linked devices** on your main phone, or you upgraded from an early v2.0.0 build whose encryption state isn't compatible with libsignal. The Link screen says so; scan the QR code to link again.

</details>

<details>
<summary><strong>"Beacon couldn't start" screen</strong></summary>

On KaiOS 4.0, WebAssembly is blocked; follow [KaiOS 4.0: enable WebAssembly](#kaios-40-enable-webassembly). On other versions, the screen says whether part of the app is missing (reinstall the ZIP) or the phone's software is too old. **Show details** has the technical reason.

</details>

<details>
<summary><strong>Contacts or groups show as numbers or IDs</strong></summary>

Run **Settings → Linked device → Sync with your phone** while your main phone is online.

</details>

<details>
<summary><strong>Messages from before linking are missing</strong></summary>

Expected. Signal doesn't keep message history on its servers, so a linked device only has messages from the moment it was linked. Messages sent while the KaiOS phone is off are queued by Signal and arrive when you open the app.

</details>
