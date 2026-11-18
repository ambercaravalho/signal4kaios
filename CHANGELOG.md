# Changelog

Each `## v<version>` section becomes the notes of that GitHub Release; the release workflow fails if the tag has no section here.

## v3.0.0

Beacon keeps running in the background, so messages and calls keep arriving. On v2.11.0 or later, update from Beacon itself: **Options → Update to Beacon 3.0.0** on the chat list. Your chats and settings carry over.

### Added

- **Beacon stays connected in the background.** Close the flip, or press Back on the chat list, to leave Beacon running; it keeps its connection to Signal with the screen off, so notifications and calls arrive as they do with Beacon open. Before, the phone paused Beacon's connection within a minute or two of the screen turning off, and messages waited until you opened it. To keep the connection, Beacon wakes the phone about once a minute while it's in the background, which uses some battery.
- **Incoming calls bring Beacon forward.** A call that comes in while Beacon is in the background shows the call screen, ringing, so you can answer it.
- **A notification when Beacon was closed.** If the phone closes Beacon, for example to free memory, a **Beacon was closed** notification appears within a few minutes; select it to open Beacon again. On KaiOS 3.0 and 3.1, where the phone allows it, Beacon first reopens itself in the background instead, and notifies you for the messages that arrived while it was closed.

### Changed

- **End asks before closing Beacon.** The first press shows a reminder; press End again within 3 seconds to close Beacon. Back on the chat list, or closing the flip, goes to the home screen and keeps Beacon running. On a call, End still hangs up.
- **New permission:** `background-window`, which KaiOS 3.x uses to reopen Beacon in the background. KaiOS 4.0 doesn't grant it, and installs as before.

## v2.11.3

No more message requests from safety number changes. On v2.11.0 or later, update from Beacon itself: **Options → Update to Beacon 2.11.3** on the chat list. Your chats and settings carry over.

### Fixed

- **Safety number changes no longer show up as message requests.** The history your phone sends when you link records a safety number change for people you've never messaged, and Beacon made a chat, usually a message request, for each of them. Beacon now leaves those out, like Signal does, and the first time 2.11.3 starts it removes the chats that hold nothing but safety number changes. Pinned chats and chats with any messages stay. Nothing is deleted on your other devices.

## v2.11.2

Nicknames stay put. On v2.11.0 or later, update from Beacon itself: **Options → Update to Beacon 2.11.2** on the chat list. Your chats and settings carry over.

### Fixed

- **Nicknames no longer disappear.** A nickname you set, in Beacon or on another device, now stays through syncs with your phone and through app updates. Before, a contacts sync from your phone, or a sync that ran before a new nickname was saved to Signal, could replace it with the contact's phone name, profile name, or number. Nicknames that went missing come back on their own the first time Beacon connects after updating.
- **Names follow Signal's order:** your nickname, then the name in your phone's contacts, then their profile name, then their username or number.

## v2.11.1

About Beacon gets its own place in Settings. On v2.11.0, update from Beacon itself: **Options → Update to Beacon 2.11.1** on the chat list. Your chats and settings carry over.

### Changed

- **Settings → About Beacon**, at the bottom of Settings, holds the version, **Check for updates**, **Check for updates automatically**, and Source code, which used to be at the bottom of **Help**. Help now lists only the guides.
- **Old updates are deleted.** Beacon deletes the update files it saved to your phone once the new version starts, or when a newer update replaces one you didn't install. To do that, Beacon now has permission to read and delete files in the phone's storage; it only deletes the update files it saved itself. Photos, music, and videos stay add-only.

## v2.11.0

Beacon now updates itself. Install this version over v2.10.9 the way you installed Beacon before, one last time; your chats and settings carry over, and after that Beacon finds and downloads new versions itself.

### Added

- **Updates without a computer.** Beacon checks for a new version about once a day. When one is out, the chat list says so, and a security update also shows a notification. **Options → Update to Beacon …** downloads it, checks that it arrived intact, and installs it over Beacon on phones where OStore can install from the phone's storage. On other phones, Beacon saves the update to your phone and shows how to install it with OStore's **Manual Install**.
- **Settings → Help → Check for updates**, and **Check for updates automatically**, which is on by default. Each check asks GitHub, which sees your phone's internet address.

### Changed

- **Release notes** list only the changes written for each release, without GitHub's list of merged pull requests, and keep the **Full Changelog** link.

## v2.10.9

Upright photos and the latest libsignal. Install over v2.10.8; your chats and settings carry over.

### Fixed

- **Photos taken sideways** now arrive upright. Beacon removes location and camera data from photos before sending them, and that used to lose which way up the photo was taken. This applies to your profile photo and link preview images too.

### Changed

- **libsignal 0.108.0.** Beacon now uses Signal's latest encryption library, which also rejects a kind of forged first message that an honest Signal app never sends.

## v2.10.8

The last fixes from the pre-launch review: accounts and security, voice messages, groups, calls, and many smaller rough edges. Install over v2.10.7; your chats and settings carry over.

### Fixed

- **Relinking after a number change** now opens your existing history, instead of starting an empty one under the new number.
- **Link previews** are no longer fetched for addresses on your own network, like a router's page.
- **Screen lock.** Changing the phone's clock no longer skips the wait after wrong PINs. **Forgot PIN** now asks once more before it deletes everything.
- **Shared debug logs** also shorten usernames and other phone number formats.
- **Signing in to Signal** never puts your device password in a web address; without Beacon's secure connection, it doesn't connect.
- **Long voice messages** are encoded while you record, so even a 15-minute one is ready as soon as you stop and no longer runs the phone out of memory.
- **Audio files you pick** are no longer sent as voice messages; only recordings are. **Mentions** in a photo's caption now reach the people you mention, and files you save get Signal's names, like `signal-2026-11-16-093000.jpg`.
- **Asking your main phone for an attachment** waits up to 30 seconds, so a phone that's asleep has time to answer.
- **Disappearing message timers** follow Signal's timer versions, so an older change from another device no longer overrides a newer one.
- **Group messages that didn't reach everyone** say **Sent to some members**, and **Message details** says how many members missed it.
- **Group errors** now say what went wrong, for example **Make another member an admin before you leave** or **Only admins can change that**. When Signal wants your main phone to confirm the account, Beacon says so.
- **Groups you left** no longer show a message box; **You're no longer in this group.** takes its place.
- **Joining a group by its link** with an admin's approval opens the group normally once you're approved, instead of as a message request.
- **Group members' names** now show for people you don't otherwise know, and anyone still loading shows as **Unknown** instead of a long ID.
- **Quick reactions** are the ones you chose on your main phone, else Signal's defaults in your skin tone. **Keep muted chats archived** is now kept in step with your other devices.
- **Read receipts** now go out for every unread message when you open a chat, not just the last 10, and never for notices like group changes.
- **Back on a message** returns to the message box instead of leaving the chat.
- **Answering a call** opens the microphone first, so your first words reach the caller; if the microphone can't open, the call is declined. A call that couldn't connect or dropped now says **Voice call failed**.
- **Calls from message requests** no longer connect at all; they show as missed, as in Signal.
- **Old call offers** are now judged by Signal's clock instead of the phone's, so a phone with the wrong time still rings for new calls.
- **Archiving a chat unpins it**, as in Signal, and archived chats no longer count toward the 4 pinned chats.
- **Search** reads only the newest messages it needs, so it's quicker with a long history.
- **Softkey labels** are short enough to fit, for example **Save**, **Verify**, **From photo**, and **Earpiece**.
- **Starting Beacon** shows its name on a blue screen instead of a blank one while it loads, and linking shows **Finishing up** only once your main phone has scanned the code.
- **The link screen** says why you need to link again: unlinked from your main phone, unlinked here, lost keys, or your main phone asking for it.
- **Wording.** Beacon now says "your main phone" whenever it means your Signal phone.
- **Storage permission.** Beacon now asks only to add files to the phone, not to read them.
- **Docs.** The user guide's settings section is reorganized, with its own Debug heading, and the guide and architecture notes describe this version's changes.

## v2.10.7

Smaller fixes for calls, messages, media, your profile, linking, and the connection. Install over v2.10.6; your chats and settings carry over.

### Fixed

- **Screen lock after a call.** With the screen lock on, Beacon locks again as soon as a call ends, instead of a few seconds later, and a notification tapped in that moment no longer opens a chat.
- **Back on a ringing call** now silences the ringtone and vibration and leaves the call on screen to answer. The left softkey and End still decline.
- **Calls stay up longer on weak connections.** When renewing the call's relay fails, Beacon tries once more instead of letting the call drop a few minutes later.
- **Message status** now moves on to delivered or read even when the receipt arrives before Signal has finished sending the message.
- **Backslashes** you type, as in `C:\path`, now stay in the message; a backslash only stops a formatting marker like `*` from formatting.
- **Editing a message edited on another device** now starts from its latest text.
- **Forward** now sends every attachment in a message, including all the photos in an album. Before, messages with more than one attachment couldn't be forwarded.
- **Downloads** stop at the size the sender's message gave, and photos of unknown size no longer download on their own.
- **Storage.** The attachment cache now keeps at most 50 MB as well as at most 150 files, so a few videos can't fill the phone. Files a failed message needs for **Retry** are the last to go.
- **View-once media** counts as viewed once it's on screen, so leaving while it downloads lets you open it later.
- **Back asks first** before it throws away attachments waiting in a chat or a voice recording.
- **Saving your profile** no longer shows a new name, About, or emoji when Signal didn't get it; Beacon says the save failed instead. Choosing a username now says whether it's taken, not valid, or tried too often.
- **Linking.** If linking fails after your main phone approved it, Beacon removes the half-linked device from your account again, so **Retry** starts clean. **Skip** on the message history screen asks first, since history can only be transferred while linking.
- **When Beacon can't open its storage**, the error screen's **Options** now has **Delete all data**, so you can start again without reinstalling.
- **A wrong date or time** on the phone now gets **Check that the phone's date and time are right** instead of a plain connection error, in the connection banner too.
- **Phone numbers without a country code** in **New chat** are now read as numbers in your own country, with the leading 0 dropped (except in Italy), and **Not found on Signal** says which number was looked up.
- **List focus** stays on the same chat when the chats list reorders, for example when a new message arrives.
- **Docs.** The user guide now says that Signal removes a linked device that hasn't been opened for about 30 days, and that a call ends if the phone switches networks. The setup guide and architecture notes now describe the debug log and where the device password is kept accurately.

## v2.10.6

Fixes for disappearing messages, accounts, group invites, settings sync, your profile, and duplicate chats. Install over v2.10.5; your chats and settings carry over.

### Fixed

- **Disappearing messages you receive** now start their countdown when you read them, here or on another device, as in Signal. Before, they started when they arrived, so a message could vanish before you saw it. Unread messages from before this version start again when you read them.
- **Settings per account.** Each saved account now keeps its own profile, username, privacy and notification settings, and chat folders. Before, switching accounts or adding one carried the previous account's settings over until the next sync.
- **Group invites** now always show as a message request with **Accept**, whoever invited you, and appear on Home as soon as Beacon hears about them, even before anyone writes in the group.
- **Settings changes survive a quick exit.** Archiving, muting, pinning, blocking, nicknames, privacy settings, and folder changes are now kept on the phone until your other devices have them, and sent again the next time Beacon connects. Before, pressing Back straight after a change could lose it.
- **Your profile stays in step.** A name you change in Beacon now stays changed on your other devices instead of coming back on the next sync, your About and its emoji are loaded from your profile when you link or sync, and saving just your name no longer resends an out-of-date About.
- **Linking again** now starts with fresh keys while keeping your messages. **Unlink this phone** switches to your next saved account if you have one, and **Delete all data** removes every account's data and says so if something couldn't be deleted.
- **One chat per person.** Messages from someone you know by number no longer open a second chat with them, and chats that were already split in two are merged, with their messages and read state.

## v2.10.5

Security and privacy fixes for safety numbers, encryption keys, photos, and groups. Install over v2.10.4; your chats and settings carry over.

### Fixed

- **Safety number changes.** A chat now says your safety number has changed whenever Beacon learns a contact's new key, including when you send to them or open their profile. Before, it only said so when a message from them arrived.
- **Encryption keys stay fresh.** Beacon now checks its keys on Signal's server twice a day, adds more when they run low, and replaces its long-term keys every two days, as Signal Desktop does. Before, they were only refreshed from the Debug screen, and old keys were never deleted.
- **Photos no longer carry location data.** Photos you send are now resized to Signal's Standard quality (1600 pixels on the longest side) and re-saved, which removes location, camera, and time details. GIFs are sent as they are.
- **Group messages from people who left** or were removed are now ignored, unless the group has changed since Beacon last checked.

## v2.10.4

Fixes for notifications, the connection, reading, polls, message requests, unlinking, and large transfers. Install over v2.10.3; your chats and settings carry over.

### Fixed

- **Notifications after a reconnect.** Messages that arrive while Beacon is offline now notify once it reconnects, with one notification per chat. Before, they arrived silently.
- **Stuck connection.** When the network changes or the connection stops answering, Beacon now reconnects on its own instead of waiting until you open it.
- **Chats left open in the background** no longer mark new messages read or send read receipts. They're marked read when you come back to the chat.
- **Read on Beacon, read everywhere.** With read receipts off, reading a chat on Beacon now also clears it on your phone and other devices.
- **Messages stuck sending.** A message that was still sending when Beacon closed now shows as failed, with **Retry**, the next time you open it.
- **Polls in one-to-one chats.** You can now vote in them, and the other person's votes are counted.
- **Message requests.** Someone you never accepted, such as a member of a shared group, now starts as a message request.
- **Unblock** in a blocked group's chat now works.
- **Unlink this phone** now also removes Beacon from **Linked devices** on your main phone. When your main phone unlinks Beacon, Beacon deletes its keys and keeps your messages.
- **Large files on slow connections** no longer fail after a minute or two while they're still downloading or uploading.
- **QR codes at larger text sizes** now fit the screen, and **Up** and **Down** scroll the linking and QR code screens.

## v2.10.3

Fixes for retrying photos, safety number codes, and saving new messages. Install over v2.10.2; your chats and settings carry over.

### Fixed

- **Retry** on a photo, file, or voice message that didn't send now sends it again with its attachment. Before, only the caption was sent and the attachment was lost. Messages that failed before this version can't be retried; delete them and send again.
- **Safety number codes.** **Show code** and **Scan code** now use the same format as Signal on Android and iPhone, so you can verify each other by scanning. Codes shown by older versions of Beacon still scan.
- **Saving new messages.** Beacon now tells Signal it has a message only once the message is saved on the phone. If the phone's storage is full, Beacon warns you and keeps trying instead of losing the message.

## v2.10.2

Fixes for KaiOS 3.x, incoming calls, privacy settings, and view-once media. Install over v2.10.1; your chats and settings carry over.

### Fixed

- **KaiOS 3.0 and 3.1.** Beacon now starts on these phones; recent versions stopped at a blank screen at launch.
- **Incoming calls.** Calls from Signal on Android, iPhone, and Desktop now connect when you answer them on Beacon.
- **Read receipts and typing indicators.** Turning them off or on in **Settings → Privacy** now stays that way, and your other devices follow. Before, the next sync with your phone could switch them back.
- **View-once media** can't be opened again after it's been viewed. Before, it could reopen once Beacon had downloaded many other attachments.
- **Edits.** Someone else can no longer change the text of a message you sent.

### Changed

- **Confirmations** like **Delete all data** or **Delete chat** now need the right softkey; OK no longer confirms them.

## v2.10.1

A fix for calls with Screen lock on. Install over v2.10.0; your chats and settings carry over.

### Fixed

- **Calls while locked.** An incoming call now shows over **Screen lock**, so you can answer it without typing your PIN. Beacon locks again when the call ends.

### Changed

- **Holding the Call key** in a chat no longer records a voice message. Use **Options → Record voice message**.

## v2.10.0

Voice calls. Install over v2.9.4; your chats and settings carry over.

### New

- **Voice calls** ([#7](https://github.com/ambercaravalho/signal4kaios/issues/7)). Call someone from **Options → Voice call** in your one-to-one chat with them, and answer with OK or the Call key. Calls start on the earpiece; **Speaker** moves them to the loudspeaker, and OK mutes you. They're end-to-end encrypted as in Signal, and always go through Signal's relay servers, so the other person doesn't see your IP address. Like notifications, calls ring only while Beacon is open or in the background, and group calls and video calls stay on your phone ([Known limitations](docs/user-guide.md#known-limitations)).
- **Call history.** Each call leaves a line in its chat, such as **Missed voice call** or **Outgoing voice call · 1:05**, and a missed call counts as unread. The history is shared with your phone and other devices: answering or declining on one stops the others ringing, and clearing calls there clears them here.

### Changed

- Older call lines say **Voice call** instead of asking you to answer on your phone.

## v2.9.4

Find people by phone number, plus a fix. Install over v2.9.3; your chats and settings carry over.

### New

- **Find by phone number** now works for any number, not only your synced contacts ([#9](https://github.com/ambercaravalho/signal4kaios/issues/9)). Beacon asks Signal's contact discovery service, which runs in a secure enclave that the phone checks before it sends the number, as Signal's own apps do. A number that isn't on Signal, or whose owner chose not to be found by number, shows **Not found on Signal**. After many lookups, Beacon says how many minutes to wait.

### Fixed

- **Pinned messages.** Opening a chat with a pinned message now stays at the newest message when the pinned bar appears, instead of scrolling up a little.

## v2.9.3

A bug fix release. Install over v2.9.2; your chats and settings carry over.

### Fixed

- **Pinned polls and photos.** The pinned message bar, **Pinned messages**, and the reply and edit line above the message box now say what a message without text is, such as **Poll: Lunch?** or **Photo**, instead of showing an empty space.
- **Names in groups.** People you only know from a group now show their profile name soon after their first message, instead of a long ID.
- **View-once.** **Options → Attach** now asks, after you pick a photo or video, whether to **Attach** it or **Send as view-once**. The separate **Attach view-once photo or video** option is gone.
- **Opening a chat** with photos in it now stays at the newest message while the photos load, instead of stopping partway up.
- **Your own attachments.** Photos, voice messages, and files you send now open on this phone without asking your main phone for them, including in Note to Self. They can be forwarded and show in **Media**. Attachments sent before this version can now be fetched from your phone in Note to Self too.
- **Safety numbers** open much faster, since Beacon now works out only the one you're looking at.
- **Read on another device.** Reading a chat in Signal on your phone or computer now clears it here right away, in groups too, and closes its notification. Messages that came after the one you read stay unread.

## v2.9.2

Chats get Signal's bubble colors, plus two fixes. Install over v2.9.1; your chats and settings carry over.

### New

- **Chat colors.** **Settings → Appearance → Chat color** picks the color of your message bubbles: Automatic, or one of Signal's 22 colors and gradients. Each chat can have its own in **Chat settings → Chat color**, or follow the default. When you link with **Transfer message history**, the colors you chose on your phone come along.

### Fixed

- **Dividers in menus** now show in dark mode, and so does the title bar of menus and dialogs.
- **Your photo in member lists.** The **You** row in a group's members list shows your profile photo or initials instead of the Note to Self icon.

## v2.9.1

A small fix release. Install over v2.9.0; your chats and settings carry over.

### Fixed

- **Group photos.** Group chats now show their group photo in the chats list, search, Forward, and Chat settings, instead of only initials. A new photo set on another device shows here too.

## v2.9.0

Beacon can bring your message history over when you link it, and follows your chat folders. Install over v2.8.0; your chats and settings carry over. To get your history on a phone that's already linked, unlink it and link again (see below).

### New

- **Message history when linking.** When you link, choose **Transfer message history** on your main phone, and Beacon brings over your recent chats and messages, with reactions, edits, quotes, polls, and photos and files to download when you open them. **Skip** goes on without it; if the download stops, **Retry**, or open Beacon again to pick up where it left off. Each chat keeps its 500 most recent messages. Beacon only receives the history while linking, so to transfer it to a phone that's already linked, use **Settings → Linked device → Unlink this phone** and link again; unlinking deletes what Beacon has on the phone, and the transfer brings it back.
- **Chat folders.** Folders you made on your phone show here: **Left** and **Right** on the chats list move between them, and the header names the folder you're in. **Settings → Chats → Chat folders** adds folders (Unread, One-to-one chats, Groups, or your own), edits which chats they hold, reorders them, and deletes them, and your other devices follow.
- **Sticker packs** installed on your phone are now kept in step with Beacon, ready for sending stickers later. Stickers you receive show as before.

### Changed

- **Help** has guides on message history and chat folders, and **Learn more** at the bottom of **Chat folders**.
- **Debug** shows how many sticker packs and chat folders your account has.
- New links are named **Beacon for KaiOS** in your phone's linked devices list. You can still type a different name when you link.

### Fixed

- **Help** guides fit on the screen at every text size: the picture sits beside the caption and the QR code takes the rest of the page.

## v2.8.0

Beacon closes more gaps with the official Signal apps: notifications work the way they do on your phone, groups from strangers wait for your OK, and username QR codes scan. Install over v2.7.4; your chats and settings carry over, and chats you'd muted stay muted.

### New

- **Settings → Notifications.** Choose what notifications show (name and message, name only, or neither), turn the sound on or off, and get a notification when someone reacts to your message. **In muted chats** picks whether mentions, replies to you, and calls still notify; each chat can change these in its settings.
- **Notification profiles.** Profiles from your main phone, like Work or Sleep, follow their schedule here and let through only the people and groups they allow. Turn one on for an hour or until you turn it off, or switch it off, from **Settings → Notifications**.
- **Mute for a while.** Mute a chat for 1 hour, 8 hours, 1 day, 7 days, or always. Chat settings shows when the mute ends, and the chat unmutes on its own. Timed mutes set on your phone now carry over too.
- **Username QR codes and links.** **New chat → Scan** reads someone's username QR code, and **Open link** on a `signal.me` link opens a chat with them.
- **Polls in one-to-one chats.** **Create poll** now works in any chat.
- **Group message requests.** A group someone you don't know adds you to waits as a request: **Accept** to join in, or **Delete** or **Block** it. Choices you make on another device apply here too.
- **Asking your phone for old attachments.** When Signal's servers no longer have a photo or file, Beacon asks your main phone to upload it again, as Signal Desktop does.

### Changed

- Phone number links in chats (`signal.me/#p/`) open a chat in Beacon instead of the browser.

## v2.7.4

Help in Beacon is shorter and easier to scan, with pictures, and points you to the full guide when you need more. Install over v2.7.3; your chats and settings carry over.

### New

- **Help by topic.** **Settings → Help** lists short guides, from getting started to troubleshooting. Each shows a QR code for the full guide: scan it with another phone, or press **Open** to read it in the phone's browser.
- **Learn more.** Privacy, Chats, Phone number, Screen lock, and Proxy settings, and a safety number's **Options**, end with **Learn more**, which opens the matching guide.
- **Pictures.** The welcome screen, empty lists (chats, archived chats, contacts, search, media, blocked people, and safety numbers), and the screen shown when Beacon can't start now have a simple drawing.

### Changed

- **Shorter wording.** Hints under settings and the text in confirmations are shorter and plainer.
- **Getting help while linking.** **Help** on the welcome screen and **How to link** in the linking screen's **Options** open a guide page instead of going straight to the browser.

## v2.7.3

Beacon now opens on KaiOS 4.0 without any setup on a computer. Install over v2.7.2; your chats and settings carry over.

### Changed

- **KaiOS 4.0.** You no longer need to edit a system file over USB before the first launch. The first time Beacon opens after you install or update it, it may reload once while it sets itself up. If you made that edit for an earlier version, you can keep it or undo it; Beacon works either way.
- **Faster connection removed.** The **Settings → Debug → Faster connection** option for rooted phones that trust Signal's certificate is gone. Photos, video, and files now always use Beacon's own secure connection, like everything else. If you added Signal's certificate to your phone for it, Beacon no longer uses it.

## v2.7.2

Calls to you now ring on your phone with Beacon linked, and Beacon tells you when something in a chat needs your phone. Install over v2.7.1; your chats and settings carry over.

### Fixed

- **Calls to you.** Beacon made calls stop ringing on your phone, because it told the caller you were busy. Your phone now rings as usual.

### Changed

- **Call lines.** A call now shows **Voice call. Answer it on your phone.** instead of **Missed voice call**, and a group call says to join it from your phone.

### New

- **Payments.** A payment someone sends you shows as a line asking you to check your phone.
- **Story replies and reactions.** A reply to your story shows in the chat quoting **Story**, and a reaction shows as a line, for example **Alice reacted ❤️ to your story**.

Video calls, stories, and payments won't come to Beacon; voice calls are still on the [roadmap](https://github.com/ambercaravalho/signal4kaios/issues/7).

## v2.7.1

A behind-the-scenes cleanup release with no feature changes. Install over v2.7.0; your chats and settings carry over.

### Changed

- **Less to load.** The app's code is about a quarter smaller, so the phone has less to read when Beacon starts, and the download is a little smaller too.
- **Internal cleanup.** Large parts of the code were reorganized and duplicate code removed, which makes future features and fixes quicker to ship. Everything should look and work exactly as before; if something doesn't, please report it.

## v2.7.0

The fifth round of Signal features from the roadmap. Install over v2.6.0; your chats and settings carry over. KaiOS asks for the microphone the first time you record a voice message.

### New

- **Signal proxy.** Where Signal is blocked, **Settings → Privacy → Proxy** connects through a [Signal proxy](https://support.signal.org/hc/en-us/articles/360056052052) run by someone you trust. Type its address, or open or scan a `signal.tube` proxy link and Beacon asks whether to use it. The proxy can't read your messages or see who you talk to. While it's on, the bar under the header says when Beacon can't reach it, and nothing bypasses it except link previews, which you can turn off.
- **Your profile photo.** **Settings → Profile → Photo** picks a picture from the gallery or camera and saves the middle square, or removes your photo. Your phone and other devices pick up the change, and a photo set on your phone shows in Beacon.
- **Voice messages you record.** **Options → Record voice message** in a chat, or holding the Call key on phones that allow it, records right away with the time and a level on screen. **Stop**, then **Send** or **Cancel**; recordings stop at 15 minutes. They're sent as MP3 with a waveform so every Signal app plays them.
- **Waveforms.** Voice messages show their waveform and length in the chat.
- **Mentions in muted groups.** A muted group still notifies you when someone mentions you, as in Signal. **Chat settings → Notify for mentions** turns that off for a group, shared with your other devices.
- **Text size.** **Settings → Appearance → Text size** makes everything Small, Normal, Large, or Extra large on this phone.
- **Blurred previews.** Photos and videos show a blurred preview of themselves until they download, when the sender's app included one, and photos you send include one for others.

### Changed

- **Number changes.** When you change your number on your main phone, Beacon now follows: it shows **Your number changed to …**, keeps your chats, stays linked, and receives messages sent to the new number. Before, it needed linking again.

### Fixed

- **Profile photo kept when editing your profile.** Changing your name or About in Beacon no longer removes your profile photo.

## v2.6.0

The fourth round of Signal features from the roadmap. Install over v2.5.0; your chats and settings carry over.

### New

- **Link previews you send.** Type a link and, after a moment, **Link preview** with the page's title shows above the message box; it's sent with the message, picture included. **Options → Remove link preview** sends the link without it. Turn previews off in **Settings → Chats → Generate link previews**, which is shared with your other devices. As in Signal, the phone fetches the page itself, so the website sees that it was opened.
- **Join a group by its link.** **Open link** on a `signal.group` link, or **New chat → Scan** on a group's QR code, shows the group's name, size, and description. **Join** adds you, or **Request to join** asks the group's admins when they approve new members; you can **Cancel request** from the same link while you wait.
- **Screen lock.** **Settings → Privacy → Screen lock** asks for a PIN of 4 to 8 digits when Beacon opens, and again after it has been in the background for the time you choose in **Lock after**. Wrong PINs make you wait longer before trying again. It hides your chats but doesn't encrypt them, and a forgotten PIN means **Delete all data** and linking again.

### Changed

- **Faster group messages.** A message to a group is now encrypted once and sent to Signal in a single upload, as Signal's own apps do, instead of once per member. Large groups send much faster and use less data and battery. If that fails, Beacon sends to each member as before.

### Fixed

- **Your profile after a block.** When your main phone gives your profile a new key, which Signal does after you block someone, Beacon now picks it up. Before, Beacon kept the old key.

## v2.5.0

The third round of Signal features from the roadmap. Install over v2.4.0; your chats and settings carry over.

### New

- **Polls.** Polls show in the chat with their answers and vote counts. OK on one → **Vote** (pick again to change it, or **Remove my vote**), **View votes** lists who picked what, and the poll's author can **End poll**. In a group, **Options → Create poll** asks for a question and 2 to 10 answers, and whether people can pick more than one.
- **Link previews you receive.** A link someone sent with a preview shows the page's title and site under the message, plus its picture once downloaded. Sending previews isn't supported yet.
- **Several attachments in one message.** **Attach** now adds photos, videos, and files above the message box instead of sending at once, so you can add more (up to 32, 25 MB in total) and a caption, then **Send** them together. **Options → Remove attachments** clears them. OK on a message with several attachments → **View attachments** opens any of them.
- **Group and timer changes in the chat.** A line in the chat now says when someone renames a group, changes its description, members, admins, invites, group link, or permissions, or changes the disappearing message timer in a group or one-to-one chat, for example **Dave changed the group name to “Climbing”**. Changes made on your other devices show too.
- **Approve join requests.** In a group with an admin-approved link, admins see **Requests to join** at the top of **Members**; OK on one to **Approve** or **Deny** it.
- **Phone number privacy.** **Settings → Privacy → Phone number** sets **Who can see my number** and **Who can find me by number** (Everybody or Nobody), shared with your phone and other devices. As in Signal, a number everybody can see can also be found by everybody.
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
