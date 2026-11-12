# Setup

Install Beacon on a KaiOS 3.0, 3.1, or 4.0 phone and link it to your Signal account. The phone does all Signal encryption itself; nothing else needs to run.

- [Requirements](#requirements)
- [1. Install the app](#1-install-the-app)
- [2. Link your Signal account](#2-link-your-signal-account)
- [3. Contacts and groups sync](#3-contacts-and-groups-sync)
- [Troubleshooting](#troubleshooting)

> [!NOTE]
> Some Signal features, such as voice calls, aren't supported yet, and video calls, stories, and payments won't be. See [Known limitations](user-guide.md#known-limitations) and the [roadmap](https://github.com/ambercaravalho/signal4kaios/issues?q=is%3Aissue%20state%3Aopen%20label%3Aroadmap) before you rely on the app.

## Requirements

| | |
| --- | --- |
| **Phone** | KaiOS 3.0, 3.1, or 4.0 with Wi-Fi or mobile data |
| **Signal account** | An existing account on a primary phone (Android or iPhone) to link from |
| **KaiOS 4.0 only** | Root access, which installing third-party privileged apps needs |

## 1. Install the app

Download `signal4kaios-<version>.zip` from [Releases](https://github.com/ambercaravalho/signal4kaios/releases), or [build it yourself](development.md#build-and-test).

**OStore (no computer).** Copy the ZIP as-is (don't unzip it) to the phone's storage or SD card, then in OStore open **Manual Install → Install app from sdcard** and pick it. To update, repeat with the newer ZIP.

**Sideload over USB.** Enable debugging on the phone, install [adb](https://developer.android.com/tools/adb) and [`appscmd`](https://github.com/kaiostech/appscmd), and from a checkout of this repo run:

```sh
APPSCMD=/path/to/appscmd sh scripts/install.sh
```

> [!NOTE]
> On KaiOS 4.0, the first launch after installing or updating may reload Beacon once while it sets itself up. Nothing else is needed.

## 2. Link your Signal account

1. Open **Beacon** and press **Start** on the welcome screen. The phone shows a QR code.
2. On your main phone, open Signal → **Settings → Linked devices → Link a new device** ([Signal's guide](https://support.signal.org/hc/en-us/articles/360007320551)).
3. Scan the QR code on the KaiOS screen.
4. When your main phone asks, choose **Transfer message history** to bring your recent messages to Beacon, or **Don't transfer** to start empty.

The KaiOS phone then finishes linking. With a transfer, it shows **Message history** while the history arrives (see below); otherwise it opens your chats.

### Message history

After you choose **Transfer message history**, Beacon says **Waiting for your phone…** while your main phone prepares the history, then **Downloading messages…** and **Adding messages…** with how far along it is. Keep both phones open and online; a long history takes a few minutes. New messages wait on Signal's servers meanwhile and arrive once Beacon opens your chats.

- **Skip** (right softkey) goes on without the history.
- If the download stops, for example when the phone loses its connection, press **Retry**. Closing Beacon in the middle is fine too: it picks up where it stopped the next time it opens.
- If your main phone asks to link again, Beacon says so and **Link again** returns to the QR code.

Each chat keeps its 500 most recent messages, as it does for new ones.

## 3. Contacts and groups sync

Right after linking, the app asks your main phone for contacts, the blocked list, settings, and account keys, then reads contacts and groups from Signal's encrypted Storage Service. Keep Signal open on the main phone for a moment. Group names and members come from Signal's group server, so a group can show as "Group" for a few seconds the first time.

To sync again later, use **Settings → Linked device → Sync with your phone**.

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

The screen says whether part of the app is missing (reinstall the ZIP), the phone's software is too old, or the phone stopped part of Beacon from loading. For the last one, restart the phone and open Beacon again; if it keeps happening, [open an issue](https://github.com/ambercaravalho/signal4kaios/issues) with the text from **Show details**, which has the technical reason.

</details>

<details>
<summary><strong>Contacts or groups show as numbers or IDs</strong></summary>

Run **Settings → Linked device → Sync with your phone** while your main phone is online.

</details>

<details>
<summary><strong>Messages from before linking are missing</strong></summary>

Signal doesn't keep message history on its servers. Beacon only gets older messages when your main phone transfers them while linking: choose **Transfer message history** on the phone ([Message history](#message-history)). If you skipped it, **Settings → Linked device → Unlink this phone** and link again to transfer it; unlinking deletes what Beacon has on the phone, and the transfer brings it back. Messages sent while the KaiOS phone is off are queued by Signal and arrive when you open the app.

</details>
