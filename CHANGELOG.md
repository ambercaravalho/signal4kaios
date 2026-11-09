# Changelog

Each `## v<version>` section becomes the notes of that GitHub Release; the release workflow fails if the tag has no section here.

## v2.5.0

### New

- **Polls.** Polls show in the chat with their answers and vote counts. OK on one → **Vote** (pick again to change it, or **Remove my vote**), **View votes** lists who picked what, and the poll's author can **End poll**. In a group, **Options → Create poll** asks for a question and 2 to 10 answers, and whether people can pick more than one.
- **Link previews you receive.** A link someone sent with a preview shows the page's title and site under the message, plus its picture once downloaded. Sending previews isn't supported yet.
- **Several attachments in one message.** **Attach** now adds photos, videos, and files above the message box instead of sending at once, so you can add more (up to 32, 25 MB in total) and a caption, then **Send** them together. **Options → Remove attachments** clears them. OK on a message with several attachments → **View attachments** opens any of them.
- **Group and timer changes in the chat.** A line in the chat now says when someone renames a group, changes its description, members, admins, invites, group link, or permissions, or changes the disappearing message timer in a group or one-to-one chat, for example **Dave changed the group name to “Climbing”**. Changes made on your other devices show too.
- **Approve join requests.** In a group with an admin-approved link, admins see **Requests to join** at the top of **Members**; OK on one to **Approve** or **Deny** it.
- **Report spam.** **Options** on a message request has **Report spam**: Signal is told about their most recent messages, and they're blocked and the chat deleted here and on your other devices.

### Changed

- **Message options lead with the main action.** OK on a photo now has **View photo** first (likewise Play video, Play voice message, and Open file), so OK twice opens it. A message that didn't send has **Retry** first, and a shortened message, a shared contact, or a link puts that action ahead of React and Reply.

## v2.4.0

The second round of Signal features from the roadmap. Install over v2.3.0; your chats and settings carry over.

### New

- **Forward.** OK on a message → **Forward** sends its text (with formatting) or its photo, video, voice message, or file to another chat, contact, or group. View-once media and files sent from this phone can't be forwarded.
- **Message requests.** A new chat from someone who isn't in your contacts opens as a **Message request**. They don't get read receipts or typing until you **Accept** (OK), and **Options** also has **Delete** and **Block**. Accepting or deleting a request on another device does the same here.
- **Delete chat.** **Options** on a chat in the list (and in Archived chats) has **Delete chat**, which removes it from this phone and your other linked devices.
- **Delete for me syncs.** Deleting a message for yourself also deletes it on your other linked devices, and deletes made there show up here.
- **Admins can delete for everyone.** In a group where you're an admin, **Delete for everyone** works on anyone's message for 24 hours, as in Signal. Messages an admin deleted read **An admin deleted this message.**
- **Edit history.** **Message details** on an edited message lists its earlier versions. A message can be edited up to 10 times, as in Signal.
- **Shared contacts** show as a contact card. OK on one offers **Message** them when they're in your Signal contacts, or **Copy number**.
- **Default timer for new chats** in **Settings → Privacy** starts disappearing messages in a new one-to-one chat when you send the first message. It syncs with your other devices.
- **Private delivery icon** in **Settings → Privacy** shows **Delivered privately** in **Message details** when Signal's servers couldn't see who sent a message. It syncs with your other devices.
- **Emoji skin tones.** **Options → Skin tone** in the emoji picker picks one of six tones for emoji that have them, including reactions.
- **Media.** **Chat settings → Media** lists a chat's photos, videos, voice messages, and files, newest first. OK opens one in the viewer.

### Changed

- **The emoji picker's right softkey** is now **Options**, with **Category** and **Skin tone**.

### Not changed

- **Group message requests** aren't supported yet. Being added to a group by someone you don't know still shows the group as a normal chat.

## v2.3.0

A round of smaller Signal features from the roadmap. Install over v2.2.0; your chats and settings carry over.

### New

- **Drafts.** Text you leave in the message box stays with that chat, and the chat list shows it as **Draft:** until you send or clear it.
- **Mentions reach people.** Picking someone with **Mention** in a group now sends a real Signal mention, so it shows as a mention on their phone instead of plain text.
- **Mark as unread.** **Options** on a chat in the list has **Mark as unread** (and **Mark as read**). The chat shows a dot until you open it, and the mark syncs with your other devices.
- **Send view-once photos and videos** with **Options → Attach view-once photo or video** in a chat. View-once media has no caption, so whatever you typed stays in the message box.
- **Chat notices.** Missed calls, a changed safety number, and group calls now show as a line in the chat instead of a message. A missed call still counts as unread and notifies; OK on a safety number line opens the safety number.
- **About emoji.** **Settings → Profile → About emoji** picks the emoji shown next to your About.
- **Replies to photos and files** show what kind of attachment the reply is about, here and on the other person's phone.

### Changed

- **Groups where only admins can send** show **Only admins can send messages** in place of the message box when you're not an admin.
- **Opening a voice message, video, or view-once media** tells the sender you viewed it (when read receipts are on) and tells your other devices. View-once media you open on another device can no longer be opened here.
- **Renaming this phone** or **changing your username** on your main phone now shows up in Beacon without relinking.
- **Link preview and sealed sender indicator settings** from your phone are kept in sync, ready for when Beacon supports them.

## v2.2.0

An optional tweak for rooted phones. Install over v2.1.1; nothing changes unless you turn it on.

### New

- **Lighter photo and file transfers on rooted phones.** If the phone trusts Signal's root certificate, Beacon sends and receives photos, video, voice notes, and files over the phone's built-in TLS, so the app does less work and stays more responsive while media loads. Messages, sign-in, sync, and linking keep using Beacon's own connection. A new script, `scripts/signal-cert.mjs`, installs the certificate over USB, backs up the phone's certificate database first, and can remove it again. See [Optional for rooted phones: trust Signal's certificate](https://github.com/ambercaravalho/signal4kaios/blob/main/docs/setup.md#optional-for-rooted-phones-trust-signals-certificate).
- **Settings → Debug → Faster connection** shows whether it's on, links to the steps, and can check again after you install the certificate.

### Not changed

- **No notifications while Beacon is fully closed**, even with the certificate installed. Signal only delivers messages to a connection that sends a sign-in header, and a closed app can't open one.

## v2.1.1

Fixes from using v2.1.0 on a phone. Install over v2.1.0 or v2.0.1; nothing else changes.

### Changed

- **Archived chats** moved from a tab to an **Archived chats** row at the bottom of the chat list, as in Signal for Android. It shows how many chats are archived and opens them on their own screen. The row appears only when you have archived chats.
- **Options menus** separate related items into groups, such as attaching and emoji apart from mute and chat settings.
- **Message times** sit at the end of the last line of text, together with the disappearing-message timer and the ticks, so short messages are one line tall. On a photo with no caption, the time sits on the photo's corner.

### Fixed

- **Long messages and photos** no longer get stuck partly off screen. Long text is shortened with **Read more**, and **Read full message** in the message's options shows all of it. Photos are a little smaller in the chat, and **View photo** still opens them full size. Anything still taller than the screen scrolls a step at a time.
- **Options menus** no longer push the screen behind them up while they open.
- **The message box** no longer has a stray line under it or a scrollbar, and its "Message" hint is centered.
- **Chat settings** shows the photo, name, and member count again when you scroll back to the top.

## v2.1.0

signal4kaios is now **Beacon**. v2.1.0 is a full redesign: every screen is rebuilt to look and work like a KaiOS 3 and 4 app, in Signal's colors, with wording that makes sense without knowing how Signal works. Your chats, settings, and link carry over; there's nothing to redo.

### New

- **New name and icon.** The app is called Beacon on the phone, with a new launcher icon. It's an unofficial app and says so on the welcome screen. The project, its downloads, and its updates stay at [signal4kaios](https://github.com/ambercaravalho/signal4kaios).
- **KaiOS-style design.** Lists, softkeys, options menus, and dialogs follow KaiOS's own apps, so every screen works the same way: OK selects, the right softkey opens **Options**, and the left softkey goes back.
- **Light and dark themes** in Signal's colors, under **Settings → Appearance**.
- **Chats list** with Chats and Archived tabs, unread counts, pinned and muted chats, and who's typing. **New chat** is on the left softkey.
- **Inside a chat**: day dividers, a pinned-message bar, photos that load as you scroll to them, spoilers that reveal when you select the message, and a message details screen with the full delivery status.
- **Plain-language settings** grouped as Linked device, Chats, Privacy, Appearance, and Help, with a short explanation under each option.
- **Settings → Debug** gathers the technical details in one place: account and device IDs, PreKey counts, the connection, storage use, and the debug log. **Share log** sends a copy with your number and IDs shortened.
- **Clearer errors.** Problems now say what happened and what to do, such as "Couldn't connect. Check your internet connection.", instead of server codes.

### Changed

- **Read receipts and typing indicators** now work both ways, as in Signal: if you turn yours off, you also stop seeing other people's.
- **A smaller app.** The screens are one optimized bundle, about half the size of v2.0.1's scripts, and the emoji picker carries only the emoji KaiOS can draw.
- **Start-up problems** show a **Beacon couldn't start** screen that says what to do, with the technical reason under **Show details**.

### Before you upgrade

- **Install over v2.0.1.** Your account, chats, and settings stay. The entry on your main phone's **Linked devices** list keeps its old name until you link again.
- **No notifications while Beacon is fully closed**, as in v2.0.1. Keep it open in the background. v2.1.0 also deletes the sign-in copy v2.0.x kept for that check, since it couldn't use it.

## v2.0.1

v2.0.1 makes the app work on a stock phone. v2.0.0 couldn't link, failing with **Provisioning connection closed (code 1015)**, and it never received messages. Upgrade from v2.0.0 and link the phone again.

### Fixed

- **Connecting to Signal.** Signal's servers use a certificate from Signal's own authority, which KaiOS doesn't trust, so every connection failed. The app now makes its own secure connection to Signal's servers and trusts only Signal's certificates, the same ones Signal's official apps pin. It needs a new permission, **Connect securely to Signal servers**, which KaiOS grants when you install.
- **Receiving messages.** Messages now arrive while the app is open. v2.0.0's connection never signed in to Signal, so it could send but not receive.
- **Linking.** A new link now keeps its encryption keys after the app restarts. Adding a second account no longer overwrites the first account's keys.
- **Battery.** v2.0.0 doubled its background wake-up alarms every 5 minutes. The app now keeps a single alarm and clears the extra ones on first launch.
- **Speed.** A send no longer waits behind a burst of profile and avatar downloads.

### Before you upgrade

- **Link again if you linked v2.0.0.** On your main phone, remove the old **Signal4KaiOS** entry from **Linked devices**. Then scan the QR code in the app.
- **Keep the app open in the background for notifications.** The new-message check that runs while the app is fully closed can't reach Signal, so it doesn't notify you. Signal still holds your messages until you open the app. See [Known limitations](https://github.com/ambercaravalho/signal4kaios/blob/main/docs/user-guide.md#known-limitations).
- **Tested on KaiOS 4.0.** KaiOS 3.0 and 3.1 should work the same way but haven't been tested on a phone yet. If linking fails there, please [open an issue](https://github.com/ambercaravalho/signal4kaios/issues) with the debug log.

## v2.0.0

signal4kaios is rebuilt as a standalone Signal app. It links to your account as a linked device, like Signal Desktop, and does all encryption on the phone with Signal's official [libsignal](https://github.com/signalapp/libsignal). You no longer need a computer, a server, Docker, or signal-cli.

> [!IMPORTANT]
> This is the first release of the rebuilt app and it's still a work in progress. Calls, stories, link previews, polls, and looking up phone numbers that aren't in your contacts aren't supported yet. The [roadmap](https://github.com/ambercaravalho/signal4kaios/issues?q=is%3Aissue%20state%3Aopen%20label%3Aroadmap) lists every missing feature.

### Before you upgrade

- **KaiOS 3.0, 3.1, or 4.0 is required.** KaiOS 2.5 is no longer supported.
- **Link the phone again.** The self-hosted gateway is gone, so after installing, scan the app's QR code from Signal on your main phone (**Settings → Linked devices → Link a new device**). You can then shut down your old gateway and remove its device from **Linked devices**.
- **KaiOS 4.0 blocks WebAssembly by default.** Do the one-time [rooted WebAssembly step](https://github.com/ambercaravalho/signal4kaios/blob/main/docs/setup.md#kaios-40-enable-webassembly) before the first launch.

### What you can do

- **Chat**: 1:1 and group chats with reactions, replies, edits, delete for everyone, text formatting, read receipts, typing indicators, disappearing messages, and pinned messages.
- **Share media**: photos, video, voice notes, and files. Stickers and view-once media you receive display too.
- **Manage groups**: rename, description, timer, add and remove members, invites, admins, permissions, group links, leave, and block and leave. Changes reach everyone in the group.
- **Manage contacts and your account**: rename contacts, block and unblock people and groups, edit your profile name and about, and set a Signal username with a QR code to share.
- **Stay in sync**: contacts, groups, nicknames, blocking, archived, muted, and pinned chats, and your username sync with your other Signal devices. Chats you read elsewhere are marked read here.
- **Stay secure**: post-quantum encryption, sealed sender, and safety number verification by digits or QR code.
- **Get notified**: messages raise notifications in the background, and a periodic check shows **New Signal message** while the app is closed.
- **Use several accounts** on one phone.

See the [user guide](https://github.com/ambercaravalho/signal4kaios/blob/main/docs/user-guide.md) for the keypad reference and every feature.

### License

The app bundles libsignal, which is AGPL-3.0-only. The app's own code stays GPL-3.0; see [NOTICE](https://github.com/ambercaravalho/signal4kaios/blob/main/NOTICE).

## v1.1.3

Push notifications on KaiOS 3.0+ recover on their own after a restart, and the gateway no longer piles up dead push subscriptions. Closed-app notifications on KaiOS 3.0+ phones still depend on KaiOS's push service, which currently accepts pushes for sideloaded apps without delivering them.

### App

- KaiOS 3.0+ deletes every app's push subscription when the phone restarts after anything other than a clean power-off (a crash, a battery pull). The app now re-subscribes and re-registers in the background at boot instead of waiting until you open it.
- Settings → Debug log also shows push errors and background re-subscribes.
- Removed unused system-message entries from `manifest.webmanifest`.

### Gateway

- When a phone registers a new push subscription, its older ones are dropped. KaiOS's push service never reports dead subscriptions, so they used to accumulate.
- Phones that drop off without closing their connection are detected within a minute, so they're no longer treated as "open" and skipped for push.
- New `npm run push-test [number] [--empty] [--encoding aesgcm|aes128gcm]` sends a test push from the gateway host.

### Upgrading

- In your checkout: `git pull`, then `docker compose -f docker/docker-compose.yml pull` and `docker compose -f docker/docker-compose.yml up -d`.
- Install the new ZIP on the phone and open the app once.

## v1.1.2

Setting up the backend takes fewer steps: linking your Signal account is one command, and push notifications need no configuration. The phone app is unchanged apart from its version number.

### Gateway

- Linking your Signal account is one command: `docker compose -f docker/docker-compose.yml exec gateway npm run link` shows a QR code in the terminal and waits until you've scanned it. You no longer edit `docker-compose.yml` to open a port or visit a URL in a browser.
- The gateway generates its push (VAPID) keys on first start and keeps them in its data volume, so notifications show the message text without any setup and `docker/.env` is optional. Keys you've already set in `docker/.env` keep working.
- Pairing keeps finding your Signal number after the next signal-cli-rest-api release, which changes how it lists accounts.

### Removed

- The OStore source at `ambercaravalho.github.io/signal4kaios`. Current OStore builds can't add custom sources, so it couldn't be used. On KaiOS 3.0+, install and update by copying the ZIP from Releases to the phone and using OStore's **Manual Install** tab → **Install app from sdcard** (see [Setup](https://github.com/ambercaravalho/signal4kaios/blob/main/docs/setup.md#3-install-the-app)).

### Upgrading

- In your checkout: `git pull`, then `docker compose -f docker/docker-compose.yml pull` and `docker compose -f docker/docker-compose.yml up -d`. Your linked Signal account and paired phones carry over.
- If you published signal-cli-rest-api's port for linking, `git pull` removes it from `docker/docker-compose.yml`; if you have local edits there, delete the `ports` lines under `signal-cli-rest-api` yourself.
- If you never set VAPID keys, open the app once after upgrading so it picks up the gateway's new keys; notifications then include the message text.

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
