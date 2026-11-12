# User guide

Everything Beacon does, driven from the keypad. Installing and linking are in [Setup](setup.md).

- [Keys](#keys)
- [Chats list](#chats-list)
- [Inside a chat](#inside-a-chat)
- [Media](#media)
- [Starting a chat and searching](#starting-a-chat-and-searching)
- [Chat settings, groups, and safety numbers](#chat-settings-groups-and-safety-numbers)
- [Settings](#settings)
- [Notifications](#notifications)
- [What lives on the phone](#what-lives-on-the-phone)
- [Known limitations](#known-limitations)

## Keys

Beacon follows the KaiOS layout: the bar at the bottom names what the left softkey, the center key (OK), and the right softkey do on the current screen.

| Key | Chats list | Inside a chat |
| --- | --- | --- |
| **Up / Down** | Move between chats | Move between messages and the message box |
| **Left / Right** | Not used | Move the cursor while typing |
| **OK** | Open the chat | **Send** from the message box, or open a message's options |
| **Left softkey** | **New chat** | **Back**, or **Cancel** a reply or edit |
| **Right softkey** | **Options** | **Options** |
| **Back** | Close Beacon | Delete a character while typing, otherwise go back |

> [!TIP]
> In a list, the focused row is highlighted in blue. Long names scroll sideways when focused.

## Chats list

Each row shows the avatar (profile photo, or initials on the person's Signal color), the name, the time, a preview, "Typing…", or your unsent **Draft:**, and an unread count (a plain dot for a chat you marked as unread). Pinned (📌) chats sort first; muted chats show a muted icon. Your own number appears as **Note to Self**. A strip under the header says **Connecting…** or **No connection** while Beacon isn't connected.

As in Signal for Android, archived chats sit behind an **Archived chats** row at the bottom of the list, which shows how many there are and appears only when you have some. Open it to see them; **Options** there has Chat settings, Unarchive, Mute, Mark as read or unread, and Delete chat.

**Options** on a chat: Chat settings, Pin or Unpin chat (up to 4), Archive, Mute or Unmute, Mark as read or Mark as unread, Mark all as read, Search, Settings, and Delete chat. **Mute** asks for how long: 1 hour, 8 hours, 1 day, 7 days, or Always; the chat unmutes on its own when the time is up. **Delete chat** removes the chat and its messages from this phone and your other linked devices.

A new chat from someone who isn't in your contacts, or a group someone you don't know added you to, shows **Message request** under its name. See [Message requests](#message-requests).

## Inside a chat

Messages run oldest to newest with the message box at the bottom; moving up past the top loads older messages. The time, the disappearing-message timer, and the ticks sit at the end of the last line of text. A long message is shortened to fit the screen and ends with **Read more**; a message still too tall to fit scrolls a step at a time as you press Up or Down. Sent messages show a clock while sending, one tick when sent, two when delivered, and two blue ticks when read. A message that didn't send says **Not sent**.

OK on a message opens its options. The first one is what the message is most likely for, so OK twice opens a photo: **Retry** on a message that didn't send, then **View photo**, **Play video**, **Play voice message**, or **Open file**, the shared contact's action, **Read full message** on a shortened message, and **Open link**. After those:

- **React**: pick from six quick reactions or any emoji; pick your current reaction again to remove it.
- **Reply** and **Copy text**.
- **Forward** sends the text (with its formatting) or the attachment to another chat, contact, or group after you confirm. View-once media and files sent from this phone can't be forwarded.
- **Edit** (up to 10 times) and **Delete for everyone** on your own messages for 24 hours, as in Signal. Group admins also get **Delete for everyone** on other people's messages for 24 hours; those read **An admin deleted this message.**
- **Pin message** (for everyone in the chat), **Message details**, and **Delete for me**, which also deletes the message on your other linked devices.
- **Message details** shows the full text, when it was sent, its status, reactions, when it disappears, earlier versions of an edited message, and **Delivered privately** when **Private delivery icon** is on in **Settings → Privacy**.
- **Shared contacts** show as a card; OK offers **Message** them when they're in your Signal contacts, or **Copy number**.
- **Link previews** show the page's title and site under the text, with its picture once it's downloaded. When you type a link, **Link preview** and the page's title appear above the message box after a moment, and the preview goes with the message; **Options → Remove link preview** sends just the link. Messages with attachments don't get previews. The phone fetches the page itself, as Signal does, so the website sees that it was opened; turn this off in **Settings → Chats → Generate link previews**.
- **Polls** show their question, answers, and vote counts. OK → **Vote** picks your answer (or answers, when the poll allows several); vote again to change it, or **Remove my vote**. **View votes** lists who picked what, and the person who made the poll can **End poll**.

**Options** in a chat: Attach, Attach view-once photo or video, Record voice message, Insert emoji, Mention (groups), Create poll, Pinned messages, Mute, and Chat settings.

- **Create poll** asks for a question and 2 to 10 answers; leave an answer empty to finish. Then pick whether people can choose one answer or several. Polls work in groups and in one-to-one chats.

- **Drafts**: text left in the message box stays with the chat until you send or clear it.
- **Mentions**: in a group, **Mention** picks a member and sends a Signal mention.
- **Emoji**: **Insert emoji** opens the picker; its **Options** has **Category** and **Skin tone**, which picks one of six tones for emoji that have them, reactions included.
- **Notices**: calls, payments, reactions to your story, a changed safety number, group calls, disappearing message timer changes, and group changes (name, description, members, admins, invites, join requests, group link, and permissions) show as a line in the chat, for example **Dave added you**; when Signal doesn't say who made a group change, the line just says what changed. OK on one offers **Delete for me**, and on a safety number line **View safety number**. Calls, payments, and stories happen on your phone, so their lines say so, for example **Voice call. Answer it on your phone.** A reply to your story shows as a message quoting **Story**.
- **Groups where only admins can send** show **Only admins can send messages** in place of the message box.

- **Text formatting**: type `**bold**`, `*italic*`, `~strikethrough~`, `` `monospace` ``, or `||spoiler||`. Spoilers stay hidden until you focus the message. Prefix a marker with `\` to type it literally. Turn this off in **Settings → Chats**.
- **Disappearing messages**: set the timer in **Chat settings**. Messages you send carry the timer, and the phone deletes expired messages on its own. **Settings → Privacy → Default timer for new chats** starts the timer in a new one-to-one chat when you send the first message.
- **Read receipts and typing indicators**: turn yours off in **Settings → Privacy**. Like Signal, turning them off also hides other people's.
- Reading a chat on another of your devices clears its unread count here.

### Message requests

A new one-to-one chat from someone who isn't in your contacts, and whom you haven't accepted, opens as a message request: **{name} wants to message you** sits in place of the message box. Until you accept, they don't get read receipts or see you typing.

- **Accept** (OK) lets you reply and shares your profile with them.
- **Options** has **Accept**, **Delete** (removes the chat), **Block**, and **Report spam**, which tells Signal about their most recent messages (Signal can't see what's in them), blocks them, and deletes the chat.
- Sending them a message from another of your devices, or accepting, deleting, or blocking there, does the same here.

A group opens as a request when someone who isn't in your contacts added or invited you, as in Signal: **{name} added you to this group** sits in place of the message box. Groups you were added to by a contact, created yourself, or already accepted on another device open as usual.

- **Accept** (OK) joins you in (taking up the invite if you were invited) and shares your profile with the members.
- **Options** has **Accept**, **Delete**, which leaves the group and removes the chat, and **Block**, which leaves the group and stops its messages. **Report spam** is only for one-to-one chats.
- Accepting, deleting, or blocking the group on another of your devices does the same here.

## Media

**Options → Attach** opens the KaiOS picker (camera, gallery, recorder, or any file). Photos, videos, and files wait above the message box (for example **2 photos**) so you can attach more and type a caption; **Send** sends them together as one message, and **Options → Remove attachments** clears them. Voice recordings send right away on their own. A message can carry up to 32 attachments and 25 MB in total, and each file is sent with its name.

**Options → Record voice message**, or holding the Call key in a chat, starts recording at once. The first time, KaiOS asks whether Beacon may use the microphone. The sheet shows the time and how loud you are; **Stop** ends the recording, then **Send** sends it on its own (your draft stays in the message box) and **Cancel** throws it away. Recordings stop by themselves at 15 minutes. Beacon sends them as MP3 with a waveform, so they play on every Signal app, and a long one takes a few seconds to prepare.

- Voice messages show their waveform and length in the chat.
- A message with several attachments has **View attachments** first in its options, which lists them to open one.

- Photos show in the chat; small ones download on their own as you scroll to them. Until then, a photo or video shows a blurred preview of itself when the sender's app included one.
- Signal's servers keep attachments for a limited time. When one is gone, Beacon shows **Asking your phone…** and asks your main phone to upload it again, as Signal Desktop does; this needs a recent Signal on the phone. If the phone doesn't have it either, it says **No longer available**. View-once media is never asked for.
- Voice messages, audio, and video play in the viewer: OK plays or pauses. Video depends on the phone's codecs; H.264 MP4 is the safe choice.
- **Save to phone** puts the file in the gallery, music, videos, or files.
- View-once media can be viewed once, then it's gone, including when you open it on another device. **Options → Attach view-once photo or video** sends your own, without a caption.
- Opening a voice message, video, or view-once media tells the sender you viewed it when read receipts are on.
- **Chat settings → Media** lists a chat's photos, videos, voice messages, and files, newest first, with a thumbnail for photos already on the phone. OK opens one in the viewer. View-once media and files sent from this phone aren't listed.

## Starting a chat and searching

**New chat** lists your contacts and groups and filters them as you type a name. Type a username to get **Find by username**, or a number to get **Find by phone number**. **Scan** (right softkey) reads someone's Signal QR code (their username code or a phone number), a group's QR code, or a proxy's.

**Username links**: **Open link** on a `signal.me` link in a chat, or scanning someone's username QR code, opens a chat with them. When its owner has reset the link, Beacon says **Link no longer works**; ask them for a new one or their username.

**Joining a group by its link**: **Open link** on a `signal.group` link in a chat, or scanning a group's QR code, shows the group's name, how many members it has, and its description. **Join** adds you right away; when the group needs an admin's approval it's **Request to join** instead, and the same screen then offers **Cancel request** until an admin decides. Once you're in, the group opens with a **You joined the group via the group link** line.

**Search** (in the chats list's Options) finds chats by name and messages by text. Messages are searched on this phone only, because Signal doesn't keep your history on its servers.

## Chat settings, groups, and safety numbers

- **For everyone**: **Media** is the first row; see [Media](#media).
- **For a person**: Nickname (saved as a Signal nickname on all your devices), Disappearing messages, Mute (showing **Muted until** a time, or **Muted always**), View safety number, and Block or Unblock. While the chat is muted, **Notify for calls** still notifies you when they call.
- **For a group**: the description, **Members**, and, as the group's permissions allow, the group name, description, and disappearing messages. While the group is muted, **Notify for mentions**, **Notify for replies to you**, and **Notify for calls** pick what still notifies you; each starts from your choice in **Settings → Notifications** and is kept in step with your other devices. Admins also get **Permissions** (who can add members, edit group info, and send messages) and **Group link** (off, on, or on with admin approval; show its QR code or reset it). **Block and leave group** and **Leave group** are at the bottom.
- **Members**: OK on a member to message them or view their safety number; admins can make or remove admins, remove members, and cancel invites. Admins also see **Requests to join** at the top when people asked to join through the group link; OK on one to **Approve** or **Deny** it. The right softkey adds people from your contacts, or by username if you have none. People Signal can't add directly are invited.
- **Safety number**: compare the 60 digits with the other phone, **Show code** for them to scan, or **Scan code** to scan theirs. OK marks the contact as verified or clears it. [About safety numbers](https://support.signal.org/hc/en-us/articles/360007060632).

## Settings

| Section | Items |
| --- | --- |
| **Profile** (top row) | Your photo, name, About, and About emoji (Signal requires a name), Username, your **QR code or link**, and Delete username |
| **Linked device** | Which number this phone is linked as, Sync with your phone, saved accounts (OK switches), Add account, Unlink this phone, and Delete all data |
| **Chats** | Text formatting; Keep muted chats archived; Generate link previews |
| **Notifications** | Notification profile; Show; Sound; Reactions to your messages; what still notifies in muted chats (see [Notifications](#notifications)) |
| **Privacy** | Read receipts; Typing indicators; Default timer for new chats; Private delivery icon; Phone number; Screen lock; Blocked; Proxy |
| **Appearance** | Theme: light or dark; Text size: Small, Normal, Large, or Extra large (this phone only) |
| **Help** | Short guides by topic, Source code, and the version |
| **Debug** | Technical details for troubleshooting (see below) |

**Help** lists guides on getting started, keys, chats and messages, groups and safety numbers, settings, the proxy, notifications, what Beacon can't do yet, and troubleshooting. Each opens a page with a QR code for the matching section of these docs: scan it with another phone, or press **Open** to read it in the phone's browser. **Learn more** at the bottom of Privacy, Chats, Notifications, Phone number, Screen lock, and Proxy, and in the safety number's **Options**, opens the same kind of page, as do **Help** on the welcome screen and when Beacon can't start, and **How to link** in the linking screen's **Options**.

**Profile → Photo** picks a picture from the gallery or camera, crops the middle square, and saves it at 512 by 512 pixels; with a photo set, it offers **Choose photo** and **Remove photo**. Your photo is encrypted with your profile key like the rest of your profile, and your main phone and other devices pick up the change. A photo set on your main phone shows here too.

**Usernames** have a name and a number, like `name.01`. Type just the name to get a number picked for you, or type the number you want.

**Privacy → Phone number** has **Who can see my number** and **Who can find me by number**, each **Everybody** or **Nobody**. With **Nobody** seeing it, only people who already have your number see it; with **Nobody** finding you, people can't start a chat with you using your number. While everybody can see your number, everybody can also find you by it, as in Signal. Both settings are shared with your phone and other devices.

**Privacy → Screen lock** asks for a PIN whenever Beacon opens. Choose 4 to 8 digits and enter them twice. **Lock after** sets how long Beacon can be in the background before it asks again: immediately, 1, 5, 15, or 30 minutes, or 1 hour (1 minute to start with). Type the PIN on the keypad and press **Unlock**. After 3 wrong PINs in a row you wait 30 seconds before the next try, and the wait doubles with each wrong PIN, up to 15 minutes. Turning the lock off asks for the PIN. Screen lock only hides Beacon: your messages aren't encrypted with the PIN, and notifications still show. If you forget the PIN, **Forgot PIN** on the lock screen → **Delete all data** is the only way back in, and then you link the phone again.

### Proxy

Where Signal is blocked, a [Signal proxy](https://support.signal.org/hc/en-us/articles/360056052052) run by someone you trust can get you connected. Open **Settings → Privacy → Proxy**, choose **Proxy address**, and type the address (like `proxy.example.com`), or open a `signal.tube` proxy link from a chat or scan one with **New chat → Scan**, and Beacon asks whether to use it. **Use proxy** turns it on and off and keeps the address. The setting applies to every account on the phone.

The proxy can see that you use Signal, but not your messages or who you talk to: everything inside stays encrypted to Signal's servers. While it's on, the bar under the header says when Beacon is connecting through the proxy or can't reach it, and Debug shows which proxy is used. Link previews still fetch the website directly, so turn off **Settings → Chats → Generate link previews** if that matters to you.

When your main phone gives your profile a new key, which Signal does after you block someone, Beacon picks up the new key too.

Each account has its own history on the phone, and switching accounts restarts Beacon.

If you change your number on your main phone, Beacon follows: it shows **Your number changed to …**, keeps your chats and history, and stays linked. Messages sent to your new number arrive as usual.

**Debug** shows the details a bug report needs: app and library versions, account and device IDs, how many one-time keys the server holds, the connection state, when the last message arrived, and storage use. It can refresh keys, ask your main phone to sync, reconnect, show the log, and **Share debug log**. The shared log has phone numbers, account IDs, and keys removed.
## Notifications

With Beacon in the background, new messages raise a notification unless the chat is muted; group notifications start with the sender's name. Selecting one opens the chat. **Settings → Notifications** has:

- **Notification profile**: profiles you made on your main phone, like Work or Sleep, follow their schedule here too. While one is on, only the people and groups it allows notify you, plus calls or mentions when the profile lets those through. Pick one to turn it on **For 1 hour** or **Until I turn it off**, or pick **Off**; your other devices follow. Profiles are created and edited on your phone; without any, the row says **Set up profiles on your phone**.
- **Show**: **Name and message**, **Name only**, or **No name or message**, for what a notification shows. This applies to this phone only.
- **Sound**: whether notifications make a sound. This applies to this phone only.
- **Reactions to your messages**: a notification when someone reacts to something you sent, for example **Reacted 👍 to: See you at 6**.
- **In muted chats**: **Notify for mentions**, **Notify for replies to you** (both in groups), and **Notify for calls**, which say what still notifies you in a muted chat. Mentions and replies start on and calls off, as in Signal. Each chat can change them in its **Chat settings**.

Reactions and the muted-chat choices are shared with your phone and other devices.

Keep Beacon open in the background to get notifications. Nothing is lost when it's closed: Signal holds your messages until Beacon connects again, and opening it delivers them. Beacon also reconnects on its own when the connection drops.

## What lives on the phone

Message history exists only on the phone, starting from when you linked. Each chat keeps about its **500 most recent messages**, and viewed media is kept in a small cache. **Settings → Linked device → Delete all data** removes everything.

Archive, mute and how long it lasts, what notifies in muted chats, notification profiles, mark as unread, pinned chats, accepted groups, the default timer for new chats, the private delivery icon setting, and phone number privacy sync with your other devices through Signal's encrypted storage; Signal allows 4 pinned chats.

## Known limitations

Beacon doesn't yet support every Signal feature. Voice calls and more are tracked on the [roadmap](https://github.com/ambercaravalho/signal4kaios/issues?q=is%3Aissue%20state%3Aopen%20label%3Aroadmap); until voice calls work, Beacon shows each call as a line in the chat and your phone rings as usual.

These won't be added, and Beacon points you to your phone for them instead:

- **Video calls**, which don't suit the phone's power or its single rear camera.
- **Stories**. Stories your contacts post don't show at all; replies and reactions to yours show in the chat.
- **Payments**. A payment shows as a line asking you to check your phone.

These aren't possible on the phone:

- **"Contact joined Signal" alerts**, which need Signal's contact discovery, which the phone can't run yet ([#9](https://github.com/ambercaravalho/signal4kaios/issues/9)).
- **An unread count on the app icon**, because KaiOS apps can't badge their icon. Unread counts show in the chats list.
- **A different notification sound for each chat**, because KaiOS apps can't pick the sound of a notification; **Settings → Notifications → Sound** turns it on or off.

These work only partly:

| Action | What happens now |
| --- | --- |
| Starting a chat by phone number | Works for numbers in your synced contacts and for Signal usernames. Other numbers can't be looked up, because the phone can't run Signal's contact discovery yet ([details](development.md#phone-number-lookup-cdsi-spike-findings)). |
| Holding the Call key to record a voice message | Works only on phones that pass a held Call key to apps. **Options → Record voice message** works everywhere. |
| Forwarding files you sent from this phone | Not possible, because the phone doesn't keep a copy it can resend. They're also left out of **Media**. |
| Notifications while Beacon is closed | None. Signal only accepts Beacon's own signed-in connection, which a closed app can't open. Leave Beacon running in the background for notifications ([details](architecture.md#network)). |
