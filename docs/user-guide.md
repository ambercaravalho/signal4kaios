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

**Options** on a chat: Chat settings, Pin or Unpin chat (up to 4), Archive, Mute or Unmute, Mark as read or Mark as unread, Mark all as read, Search, Settings, and Delete chat. **Delete chat** removes the chat and its messages from this phone and your other linked devices.

A new chat from someone who isn't in your contacts shows **Message request** under its name. See [Message requests](#message-requests).

## Inside a chat

Messages run oldest to newest with the message box at the bottom; moving up past the top loads older messages. The time, the disappearing-message timer, and the ticks sit at the end of the last line of text. A long message is shortened to fit the screen and ends with **Read more**; a message still too tall to fit scrolls a step at a time as you press Up or Down. Sent messages show a clock while sending, one tick when sent, two when delivered, and two blue ticks when read. A message that didn't send says **Not sent**.

OK on a message opens its options:

- **React**: pick from six quick reactions or any emoji; pick your current reaction again to remove it.
- **Reply**, **Copy text**, and **Open link** when the message has links.
- **View photo**, **Play video**, **Play voice message**, or **Open file** for attachments.
- **Forward** sends the text (with its formatting) or the attachment to another chat, contact, or group after you confirm. View-once media and files sent from this phone can't be forwarded.
- **Edit** (up to 10 times) and **Delete for everyone** on your own messages for 24 hours, as in Signal. Group admins also get **Delete for everyone** on other people's messages for 24 hours; those read **An admin deleted this message.**
- **Retry** on a message that didn't send.
- **Pin message** (for everyone in the chat), **Read full message** on a shortened message, **Message details**, and **Delete for me**, which also deletes the message on your other linked devices.
- **Message details** shows the full text, when it was sent, its status, reactions, when it disappears, earlier versions of an edited message, and **Delivered privately** when **Private delivery icon** is on in **Settings → Privacy**.
- **Shared contacts** show as a card; OK offers **Message** them when they're in your Signal contacts, or **Copy number**.

**Options** in a chat: Attach, Attach view-once photo or video, Insert emoji, Mention (groups), Pinned messages, Mute, and Chat settings.

- **Drafts**: text left in the message box stays with the chat until you send or clear it.
- **Mentions**: in a group, **Mention** picks a member and sends a Signal mention.
- **Emoji**: **Insert emoji** opens the picker; its **Options** has **Category** and **Skin tone**, which picks one of six tones for emoji that have them, reactions included.
- **Notices**: missed calls, a changed safety number, and group calls show as a line in the chat. OK on one offers **Delete for me**, and on a safety number line **View safety number**.
- **Groups where only admins can send** show **Only admins can send messages** in place of the message box.

- **Text formatting**: type `**bold**`, `*italic*`, `~strikethrough~`, `` `monospace` ``, or `||spoiler||`. Spoilers stay hidden until you focus the message. Prefix a marker with `\` to type it literally. Turn this off in **Settings → Chats**.
- **Disappearing messages**: set the timer in **Chat settings**. Messages you send carry the timer, and the phone deletes expired messages on its own. **Settings → Privacy → Default timer for new chats** starts the timer in a new one-to-one chat when you send the first message.
- **Read receipts and typing indicators**: turn yours off in **Settings → Privacy**. Like Signal, turning them off also hides other people's.
- Reading a chat on another of your devices clears its unread count here.

### Message requests

A new one-to-one chat from someone who isn't in your contacts, and whom you haven't accepted, opens as a message request: **{name} wants to message you** sits in place of the message box. Until you accept, they don't get read receipts or see you typing.

- **Accept** (OK) lets you reply and shares your profile with them.
- **Options** has **Accept**, **Delete** (removes the chat), and **Block**.
- Sending them a message from another of your devices, or accepting, deleting, or blocking there, does the same here.

## Media

**Options → Attach** opens the KaiOS picker (camera, gallery, recorder, or any file); the file is sent with its name. Files up to 25 MB can be sent.

- Photos show in the chat; small ones download on their own as you scroll to them.
- Voice messages, audio, and video play in the viewer: OK plays or pauses. Video depends on the phone's codecs; H.264 MP4 is the safe choice.
- **Save to phone** puts the file in the gallery, music, videos, or files.
- View-once media can be viewed once, then it's gone, including when you open it on another device. **Options → Attach view-once photo or video** sends your own, without a caption.
- Opening a voice message, video, or view-once media tells the sender you viewed it when read receipts are on.
- **Chat settings → Media** lists a chat's photos, videos, voice messages, and files, newest first, with a thumbnail for photos already on the phone. OK opens one in the viewer. View-once media and files sent from this phone aren't listed.

## Starting a chat and searching

**New chat** lists your contacts and groups and filters them as you type a name. Type a username to get **Find by username**, or a number to get **Find by phone number**. **Scan** (right softkey) reads a QR code with a phone number in it.

**Search** (in the chats list's Options) finds chats by name and messages by text. Messages are searched on this phone only, because Signal doesn't keep your history on its servers.

## Chat settings, groups, and safety numbers

- **For everyone**: **Media** is the first row; see [Media](#media).
- **For a person**: Nickname (saved as a Signal nickname on all your devices), Disappearing messages, Mute, View safety number, and Block or Unblock.
- **For a group**: the description, **Members**, and, as the group's permissions allow, the group name, description, and disappearing messages. Admins also get **Permissions** (who can add members, edit group info, and send messages) and **Group link** (off, on, or on with admin approval; show its QR code or reset it). **Block and leave group** and **Leave group** are at the bottom.
- **Members**: OK on a member to message them or view their safety number; admins can make or remove admins, remove members, and cancel invites. The right softkey adds people from your contacts, or by username if you have none. People Signal can't add directly are invited.
- **Safety number**: compare the 60 digits with the other phone, **Show code** for them to scan, or **Scan code** to scan theirs. OK marks the contact as verified or clears it. [About safety numbers](https://support.signal.org/hc/en-us/articles/360007060632).

## Settings

| Section | Items |
| --- | --- |
| **Profile** (top row) | Your name, About, and About emoji (Signal requires a name), Username, your **QR code or link**, and Delete username |
| **Linked device** | Which number this phone is linked as, Sync with your phone, saved accounts (OK switches), Add account, Unlink this phone, and Delete all data |
| **Chats** | Text formatting; Keep muted chats archived |
| **Privacy** | Read receipts; Typing indicators; Default timer for new chats; Private delivery icon; Blocked |
| **Appearance** | Theme: light or dark |
| **Help** | Version, User guide, Source code |
| **Debug** | Technical details for troubleshooting (see below) |

**Usernames** have a name and a number, like `name.01`. Type just the name to get a number picked for you, or type the number you want.

Each account has its own history on the phone, and switching accounts restarts Beacon.

**Debug** shows the details a bug report needs: app and library versions, account and device IDs, how many one-time keys the server holds, the connection state, when the last message arrived, and storage use. It can refresh keys, ask your main phone to sync, reconnect, show the log, and **Share debug log**. The shared log has phone numbers, account IDs, and keys removed.

**Debug → Faster connection** shows whether photos, video, voice notes, and files travel over the phone's built-in TLS. That needs a rooted phone that trusts Signal's root certificate; **How to turn it on** opens [the setup steps](setup.md#optional-for-rooted-phones-trust-signals-certificate), and **Check again** looks again after you install it.

## Notifications

With Beacon in the background, new messages raise a notification unless the chat is muted; group notifications start with the sender's name. Selecting one opens the chat.

Keep Beacon open in the background to get notifications. Nothing is lost when it's closed: Signal holds your messages until Beacon connects again, and opening it delivers them. Beacon also reconnects on its own when the connection drops.

## What lives on the phone

Message history exists only on the phone, starting from when you linked. Each chat keeps about its **500 most recent messages**, and viewed media is kept in a small cache. **Settings → Linked device → Delete all data** removes everything.

Archive, mute, mark as unread, pinned chats, the default timer for new chats, and the private delivery icon setting sync with your other devices through Signal's encrypted storage; Signal allows 4 pinned chats.

## Known limitations

Beacon doesn't yet support every Signal feature. Calls, stories, link previews, polls, and more are tracked on the [roadmap](https://github.com/ambercaravalho/signal4kaios/issues?q=is%3Aissue%20state%3Aopen%20label%3Aroadmap). These work only partly:

| Action | What happens now |
| --- | --- |
| Starting a chat by phone number | Works for numbers in your synced contacts and for Signal usernames. Other numbers can't be looked up, because the phone can't run Signal's contact discovery yet ([details](development.md#phone-number-lookup-cdsi-spike-findings)). |
| Scanning a username QR code | Not supported yet; ask for the username instead. Codes with a phone number work. |
| Group message requests | Not supported yet. A group someone you don't know adds you to shows as a normal chat; leave or block it in **Chat settings**. |
| Forwarding files you sent from this phone | Not possible, because the phone doesn't keep a copy it can resend. They're also left out of **Media**. |
| Notifications while Beacon is closed | None. Signal only accepts Beacon's own signed-in connection, which a closed app can't open, and trusting Signal's certificate on a rooted phone doesn't change that. Leave Beacon running in the background for notifications ([details](architecture.md#network)). |
