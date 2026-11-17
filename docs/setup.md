# Setup

Install Beacon on a KaiOS 3.0, 3.1, or 4.0 phone and link it to your Signal account. The phone does all Signal encryption itself; nothing else needs to run.

- [Requirements](#requirements)
- [1. Install the app](#1-install-the-app)
- [2. Link your Signal account](#2-link-your-signal-account)
- [3. Contacts and groups sync](#3-contacts-and-groups-sync)
- [Troubleshooting](#troubleshooting)

> [!NOTE]
> Some Signal features aren't supported: video calls, group calls, stories, and payments won't be added. See [Known limitations](user-guide.md#known-limitations) before you rely on the app.

## Requirements

| | |
| --- | --- |
| **Phone** | KaiOS 3.0, 3.1, or 4.0 with Wi-Fi or mobile data |
| **Signal account** | An existing account on a primary phone (Android or iPhone) to link from |
| **KaiOS 4.0 only** | Root access, which installing third-party privileged apps needs |

## 1. Install the app

Download `signal4kaios-<version>.zip` from [Releases](https://github.com/ambercaravalho/signal4kaios/releases), or [build it yourself](development.md#build-and-test).

**OStore (no computer).** Copy the ZIP as-is (don't unzip it) to the phone's storage or SD card, then in OStore open **Manual Install → Install app from sdcard** and pick it.

**Sideload over USB.** Enable debugging on the phone, install [adb](https://developer.android.com/tools/adb) and [`appscmd`](https://github.com/kaiostech/appscmd), and from a checkout of this repo run:

```sh
APPSCMD=/path/to/appscmd sh scripts/install.sh
```

> [!NOTE]
> On KaiOS 4.0, the first launch after installing or updating may reload Beacon once while it sets itself up. Nothing else is needed.

### Updating

Beacon checks for a new version about once a day. When there is one, the chat list says so, and a security update also shows a notification. To install it, open **Options → Update to Beacon …** on the chat list, or the same row in **Settings** or **Settings → Help**. Your chats and settings carry over.

- On phones where OStore can install from the phone's storage (the Sideload patch, Flipfull on the TCL Flip 4, or the appscmd service), Beacon downloads the update, checks it, installs it, and opens again.
- On other phones, Beacon saves `signal4kaios-<version>.zip` to the phone's storage and tells you to install it with OStore: **Manual Install → Install app from sdcard**. Delete old update ZIPs from the phone's files whenever you like.
- To check now, use **Settings → Help → Check for updates**. **Check for updates automatically** turns the daily check off; each check asks GitHub, which sees your phone's internet address.

> [!IMPORTANT]
> Versions before 2.11.0 can't update themselves. Install 2.11.0 or later the same way you installed Beacon the first time; it updates itself after that.

## 2. Link your Signal account

1. Open **Beacon** and press **Start** on the welcome screen. The phone shows a QR code.
2. On your main phone, open Signal → **Settings → Linked devices → Link a new device** ([Signal's guide](https://support.signal.org/hc/en-us/articles/360007320551)).
3. Scan the QR code on the KaiOS screen.
4. When your main phone asks, choose **Transfer message history** to bring your recent messages to Beacon, or **Don't transfer** to start empty.

The KaiOS phone then finishes linking. If that fails partway, Beacon removes the half-linked device from your account again, so press **Retry** and scan a new code. With a transfer, it shows **Message history** while the history arrives (see below); otherwise it opens your chats.

### Message history

After you choose **Transfer message history**, Beacon says **Waiting for your main phone…** while your main phone prepares the history, then **Downloading messages…** and **Adding messages…** with how far along it is. Keep both phones open and online; a long history takes a few minutes. New messages wait on Signal's servers meanwhile and arrive once Beacon opens your chats.

- **Skip** (right softkey) goes on without the history, after asking: the history can only be transferred while linking.
- If the download stops, for example when the phone loses its connection, press **Retry**. Closing Beacon in the middle is fine too: it picks up where it stopped the next time it opens.
- If your main phone asks to link again, Beacon says so and **Link again** returns to the QR code.

Each chat keeps its 500 most recent messages, as it does for new ones.

## 3. Contacts and groups sync

Right after linking, the app asks your main phone for contacts, the blocked list, settings, and account keys, then reads contacts and groups from Signal's encrypted Storage Service. Keep Signal open on the main phone for a moment. Group names and members come from Signal's group server, so a group can show as "Group" for a few seconds the first time.

To sync again later, use **Settings → Linked device → Sync with your main phone**.

## Troubleshooting

Start with **Settings → Debug**: it shows the connection state, PreKey status, and the debug log, a trace of the app's recent events (the last 300 lines, kept only in memory) that never includes keys or passwords. **Share log** sends a copy with phone numbers, account IDs, and long tokens shortened.

<details>
<summary><strong>No QR code on the Link screen</strong></summary>

Check that the phone is online, then press **Retry**, or open **Options → Get a new code**.

</details>

<details>
<summary><strong>The app went back to the Link screen</strong></summary>

The phone was removed under **Linked devices** on your main phone, Signal removed it after about 30 days without being opened, or you upgraded from an early v2.0.0 build whose encryption state isn't compatible with libsignal. The Link screen says so; scan the QR code to link again.

</details>

<details>
<summary><strong>"Beacon couldn't start" screen</strong></summary>

The screen says whether part of the app is missing (reinstall the ZIP), the phone's software is too old, or the phone stopped part of Beacon from loading. For the last one, restart the phone and open Beacon again; if it keeps happening, [open an issue](https://github.com/ambercaravalho/signal4kaios/issues) with the text from **Details**, which has the technical reason.

If it says it couldn't open your messages, restart the phone first. If that keeps happening, **Options → Delete all data** deletes every account, message, and setting in Beacon (your Signal account stays), and you can link again.

</details>

<details>
<summary><strong>"Check that the phone's date and time are right"</strong></summary>

Beacon checks Signal's certificates against the phone's clock, so a clock that's far off makes every connection fail. Set the date and time in the phone's **Settings** under **Date & Time**, or turn on automatic time, and Beacon connects again on its own.

</details>

<details>
<summary><strong>Contacts or groups show as numbers or IDs</strong></summary>

Run **Settings → Linked device → Sync with your main phone** while your main phone is online.

</details>

<details>
<summary><strong>Messages from before linking are missing</strong></summary>

Signal doesn't keep message history on its servers. Beacon only gets older messages when your main phone transfers them while linking: choose **Transfer message history** on the phone ([Message history](#message-history)). If you skipped it, **Settings → Linked device → Unlink this phone** and link again to transfer it; unlinking deletes what Beacon has on the phone, and the transfer brings it back. Messages sent while the KaiOS phone is off are queued by Signal and arrive when you open the app.

</details>
