# Setup

From nothing to Signal on your KaiOS 3.0, 3.1, or 4.0 phone. In v2.0.0, **no computer, Docker container, or gateway server is needed** — all Signal encryption and decryption happen directly on the phone.

1. [Install the app](#1-install-the-app)
2. [Link your Signal account](#2-link-your-signal-account)
3. [Syncing contacts and groups](#3-syncing-contacts-and-groups)
4. [Troubleshooting](#troubleshooting)

## 1. Install the app

Download `signal4kaios-2.0.0.zip` from [Releases](https://github.com/ambercaravalho/signal4kaios/releases), or build one locally with `npm install && npm run package`.

**With OStore (easiest, no computer needed).** Copy the ZIP as-is (do not unzip it) onto the phone's storage or SD card. In OStore, open the **Manual Install** tab, choose **Install app from sdcard**, and pick the ZIP. To update later, repeat with the newer ZIP.

**Sideloading over USB with `appscmd`.** Enable debug mode on the phone, connect it over USB, get [`appscmd`](https://github.com/kaiostech/appscmd), and run:

```sh
APPSCMD=/path/to/appscmd sh app/scripts/install-kaios3plus.sh
```

## 2. Link your Signal account

Signal4KaiOS links to your existing Signal account as a linked device, just like Signal Desktop:

1. Open **Signal4KaiOS** on your KaiOS phone and step through the Welcome screen to **Link with Signal**.
2. The phone connects to Signal's provisioning service and displays a QR code on screen.
3. On your main phone, open Signal and go to **Settings → Linked devices → Link a new device**.
4. Scan the QR code displayed on your KaiOS phone.

Once scanned, your KaiOS phone decrypts the provisioning envelope, generates and uploads its own encryption PreKeys to Signal, and opens the conversation list.

## 3. Syncing contacts and groups

Right after linking, Signal4KaiOS requests a contact and group directory sync from your main phone. Keep Signal open on your main phone for a moment so it can encrypt and upload your contacts and groups to your new linked device.

You can trigger a fresh sync at any time from **Settings → Linked account → Sync contacts & groups** or **Settings → Refresh contacts & groups**.

## 4. Troubleshooting

Start with **Settings → Debug log** on the phone: it records WebSocket connection state, PreKey status, and decryption diagnostics.

- **QR code does not appear on the Link screen.** Check that your phone has an active Wi-Fi or mobile data connection, then press **SoftRight (Refresh QR)** or select **Generate QR code**.
- **The app returned to the Link screen.** Your KaiOS device was unlinked from your main phone (in Signal → Settings → Linked devices). Scan the QR code to link again.
- **Contacts or group names show as numbers or UUIDs.** Open **Settings → Linked account → Sync contacts & groups** while your main phone is online.
- **Old messages from before linking are missing.** Expected: Signal does not store message history on its servers, so history on a linked device accrues from the moment it is linked. Messages sent to you while the KaiOS phone is turned off are queued by Signal's servers and delivered when you open the app.
