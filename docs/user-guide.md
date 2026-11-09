# User guide

Everything the app does, driven from the keypad. Installing and linking are in [Setup](setup.md).

- [Keys](#keys)
- [Conversation list](#conversation-list)
- [Chats](#chats)
- [Media](#media)
- [Starting a chat](#starting-a-chat)
- [Contacts, groups, and your profile](#contacts-groups-and-your-profile)
- [Settings](#settings)
- [Notifications](#notifications)
- [What lives on the phone](#what-lives-on-the-phone)
- [Known limitations](#known-limitations)

## Keys

| Key | Conversation list | Inside a chat |
| --- | --- | --- |
| **Up / Down** | Move the selection | Move between messages and the composer |
| **Center** | Open the chat | **Send** (composer), **Options** (message), or **View pinned** (pinned bar) |
| **SoftLeft** | **Options** for the selected chat | **Back**, or cancel a pending reply or edit |
| **SoftRight** | **New chat** | **Menu**: Attach, Emoji, Mention, Contact/Group info, Pinned messages |
| **Back** | Exit | Back to the list |

Other screens:

| Screen | Keys |
| --- | --- |
| **Message options** (Center on a message) | View full message, open links, React, Reply, Copy to composer, Edit, Retry send, Delete for everyone, Reactions, and **Info** (timestamp, delivery state, disappearing countdown) |
| **Attachment viewer** | Center plays or pauses audio and video; SoftRight **Save** stores the file on the phone |
| **New chat** | SoftRight **Scan** opens the QR scanner |
| **Settings** | SoftRight **QR code** shows your username QR code |

> [!TIP]
> KaiOS sends Back as Backspace. In a non-empty text field it deletes text; otherwise it goes back a screen.

## Conversation list

Each row shows the avatar (profile photo or colored initials), name, time, preview, and badges for unread, typing, 📌 pinned, and 🔇 muted. Pinned chats sort first. The header shows `● online`, `connecting…`, or `offline`.

Your own number appears as **Note to Self** (📔). Archived chats sit behind an **📁 Archived chats** row at the bottom.

**Options** (SoftLeft) on a chat: Contact/Group info, Pin or Unpin chat, Archive or Unarchive, Mute or Unmute, Mark all as read, Search messages, and Settings.

## Chats

Messages run oldest to newest with the composer at the bottom; scrolling up loads older history. Delivery ticks go `pending → sent ✓ → delivered ✓✓ → read` (blue). A failed send is marked and can be retried from its options.

- **Reactions**: a grid of common emoji with a "Remove my reaction" row; **Reactions (n)** shows who reacted.
- **Replies, edits, and delete for everyone**, including edits and deletes from others and from your other devices.
- **Read receipts and typing indicators**: turn yours off in **Settings → Privacy**; you still see other people's.
- **Text formatting**: type `**bold**`, `*italic*`, `~strikethrough~`, `` `monospace` ``, or `||spoiler||` (highlight a spoiler to reveal it). Prefix a marker with `\` to type it literally. Toggle in **Settings → Chats → Text formatting**.
- **Mentions**: **Menu → Mention (@)** in a group inserts a member.
- **Disappearing messages**: set the timer under **Contact info** or **Group info → Disappearing messages** (Off, 30s, 5m, 1h, 8h, 1 day, 1 week, 4 weeks). Messages you send carry the timer, and the phone deletes expired messages on a periodic sweep and when you open the chat.
- **Read state syncs**: reading a chat on another of your devices clears its unread badge here.

## Media

**Menu → Attach** opens the KaiOS picker (camera, gallery, recorder, or any file); the file is sent with its original name.

- Photos show as inline thumbnails; small images download automatically. Viewed media is cached in IndexedDB.
- Voice notes, audio, and video play in the viewer (Center to play or pause). Video depends on the device's codecs; H.264 MP4 is the safe choice.
- **Save** puts a file in the phone's gallery, music, videos, or files.
- Stickers display as images. View-once media is removed from the cache after you view it.

## Starting a chat

**New chat** (SoftRight on the list) filters your contacts and groups as you type. Pick **Start chat with …** to message a number or a Signal username, or press **Scan** to read a QR code. A scanned phone number is placed in the field; anything else is shown for you to review.

Camera support varies by device: the app uses the live camera when it can and falls back to taking one photo.

## Contacts, groups, and your profile

- **Contact info**: rename the contact (saved as a Signal nickname on all your devices), set disappearing messages, **Block** or **Unblock**, and verify the [safety number](https://support.signal.org/hc/en-us/articles/360007060632) (60 digits or QR code).
- **Group info**: members (admins are badged, invited people are marked), description, disappearing messages, and **Leave** or **Block and leave**. What you can change follows the group's permissions: rename, description, and timer; add members by number or username (people Signal can't add directly are invited); and, as an admin, remove members, cancel invites, make or remove admins, change permissions, and turn the group link on, off, or require approval, or reset it.
- **Pinned messages**: **Pin message** in a message's options pins it for everyone in the chat, in 1:1 chats and groups.
- **Your profile**: **Settings → Edit profile** sets your name and "about". Signal requires a name, so set it before or together with "about".
- **Username**: **Edit profile → Username** registers a Signal username. Type a nickname to get a random number (`name.42`), or type the number you want. **My QR code** shows your username link, and **Delete username** releases it.
- **Blocked**: **Settings → Privacy → Blocked** lists the people and groups blocked on your account; select one to unblock it. Blocking syncs to your other devices, and messages from blocked people and groups are dropped.

## Settings

| Section | Items |
| --- | --- |
| **Account** | Edit profile; **Linked account** (QR link, Sync contacts & groups, Refresh PreKeys, Unlink this phone); Switch account |
| **Chats** | Text formatting; Keep muted chats archived (on by default) |
| **Privacy** | Read receipts; Typing indicators; Blocked |
| **Appearance** | Theme (light or dark) |
| **Data** | Refresh contacts & groups; Debug log; Clear local data |
| **Help** | About & setup help, with the app version |

**Switch account** lists saved accounts and **Add account** links another. Each account has its own local history, and switching reloads the app.

## Notifications

With the app in the background, new messages raise a system notification (unless the chat is muted); group notifications start with the sender's name.

When the app is closed, a KaiOS wake alarm checks Signal's server every few minutes and shows **New Signal message** if anything is waiting; opening the app decrypts it. The app also reconnects with backoff when the connection drops. Signal holds messages for you while the phone is off.

## What lives on the phone

Message history exists only on the phone, in IndexedDB, starting from when you linked. It is pruned to about **500 messages per conversation**, and viewed media is kept in a small cache. **Settings → Clear local data** wipes it.

Archive, mute, and pinned chats sync with your other devices through Signal's encrypted Storage Service; Signal allows 4 pinned chats. **Settings → Debug log** records connection events and any message the app couldn't read.

## Known limitations

| Action | What happens now |
| --- | --- |
| Starting a chat by phone number | Works for numbers in your synced contacts and for Signal usernames. Other numbers aren't looked up in Signal's directory, because the phone can't run Signal's contact discovery yet ([details](development.md#phone-number-lookup-cdsi-spike-findings)). |
