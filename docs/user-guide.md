# User guide

Everything the app can do, and how to drive it from the keypad. No touchscreen
required.

- [Keys](#keys)
- [The conversation list](#the-conversation-list)
- [Inside a chat](#inside-a-chat)
- [Messaging features](#messaging-features)
- [Disappearing messages](#disappearing-messages)
- [Pinning](#pinning)
- [Media and attachments](#media-and-attachments)
- [QR codes](#qr-codes)
- [Starting a new chat](#starting-a-new-chat)
- [Organizing chats](#organizing-chats)
- [Contacts and your profile](#contacts-and-your-profile)
- [Groups](#groups)
- [Blocking](#blocking)
- [Accounts](#accounts)
- [Search](#search)
- [Settings](#settings)
- [Notifications and reconnect](#notifications-and-reconnect)
- [What lives on the phone](#what-lives-on-the-phone)
- [Troubleshooting](#troubleshooting)

## Keys

| Key | Conversation list | Inside a chat |
|---|---|---|
| **Up / Down** | Move the selection | Move through messages / composer |
| **Center** | Open chat (or the archived list) | Send (composer) · options (on a message) · view pinned (on the pinned bar) |
| **SoftLeft** | Options: info, pin, archive, mute, search, settings | Emoji picker (composer), or cancel reply/edit |
| **SoftRight** | New chat | Attach a file (system picker) |
| **Back** | Exit app | Back to the list |

Context menus and pickers add their own keys:

- **Message options** (Center on a message): view/play the attachment, open any
  links, react, reply, copy to composer, pin/unpin (groups only), edit, delete
  for everyone, retry, "who reacted", and an **Info** line (full timestamp,
  delivery status, and the disappearing countdown when a timer is set).
- **Attachment viewer**: Center plays/pauses audio and video; SoftLeft saves the
  file to the phone.
- **New chat**: SoftLeft opens the QR scanner.
- **Archived list**: its own SoftLeft menu (unarchive, mute).
- **Reaction / emoji picker**: a grid of common emoji; Center picks the
  highlighted one. The reaction picker adds a "Remove my reaction" row if you've
  already reacted.

Note: KaiOS delivers Back as Backspace. In a non-empty text field it edits text;
otherwise it goes back a screen.

## The conversation list

The home screen. Each row shows an avatar (real profile photo when available,
else colored initials), the name, last-activity time, a message preview, and —
when relevant — an unread badge, a typing indicator, a 📌 pinned icon, and a 🔇
muted icon. Pinned chats sort to the top. The header shows connection status:
`● online`, `connecting…`, or `offline`.

A chat with your own number appears as **Note to Self** with a 📔 notebook icon.
If any chats are archived, an **"📁 Archived chats"** row sits at the bottom.

## Inside a chat

Messages run oldest-at-top to newest-at-bottom, composer below; scrolling up
pages in older history from storage. Group sender names resolve from your address
book, nicknames, and Signal profiles.

Outgoing delivery ticks progress `pending → sent ✓ → delivered ✓✓ → read (blue)`.
Failed sends are marked and can be retried from the message options.

## Messaging features

- **Send/receive text in real time** — receive is over the WebSocket
  (`json-rpc` mode).
- **1:1 and group chats.**
- **Emoji** — SoftLeft in the composer opens a picker; the chosen emoji drops in
  at the cursor.
- **Reactions** — a grid well beyond ❤️👍👎😂😮😢, with a remove option. A
  message's **Reactions** option shows who reacted and with what.
- **Read receipts and typing indicators** — toggle either off in
  **Settings → Privacy** (you'll still see others').
- **Formatted text** — type Signal's markers and they send as real formatting:
  `**bold**`, `*italic*`, `~strikethrough~`, `` `monospace` ``, and
  `||spoiler||` (highlight a message to reveal spoilers). Prefix a marker with
  `\` to type it literally. Formatting others send renders here too; toggle
  sending in **Settings → Composer**.
- **Quote/reply**, **copy to composer**, **delete for everyone**, and **retry**.
- **Edit sent messages**, and see edits from others or from your other devices.
- **Read status syncs across devices** — reading a chat on Signal Desktop clears
  its unread badge here too.

## Disappearing messages

Set the timer from **Contact info** (direct) or **Group info** (group) →
**Disappearing messages**, then pick an interval (Off, 30s, 5m, 1h, 8h, 1 day,
1 week, 4 weeks). The change is applied on Signal, so it takes effect for
everyone in the conversation.

New messages carry the timer, and the app deletes them from the phone once the
interval elapses (enforced on a periodic sweep and on chat open). To see how long
a specific message has left, open its **options → Info**.

## Pinning

Two independent kinds:

- **Pinned messages (groups only)** — a message's **options → Pin message** uses
  Signal's group pin feature, so it **syncs to everyone**; pins from others or
  your other devices show up here too. Pinned messages get a 📌 marker and a
  **"N pinned"** bar at the top of the chat — select it to list them and jump to
  one. Signal has no 1:1 message pin, so the action is group-only.
- **Pinned conversations (local)** — from the list's **SoftLeft → Options → Pin
  chat**, pin a chat to the top. This is **local to this phone** (Signal exposes
  no sync for chat-list pins).

## Media and attachments

Press **SoftRight** in the composer to attach a file. This opens the KaiOS system
picker, which on real hardware offers Camera, Recorder, Gallery, Video, and any
file. The chosen file is sent as-is, keeping its original filename.

- **Inline photo thumbnails** in chat; small images auto-download for inline
  view. All viewed media is cached offline in IndexedDB.
- **Voice, audio, and video** play in the viewer — open the message's options,
  choose **Play video** / **Play audio**, then Center to play/pause. (Video
  decoding depends on device codecs; H.264 MP4 is the safe bet on KaiOS.)
- **Save any attachment** to the phone (gallery/music/videos/files via
  DeviceStorage) with SoftLeft in the viewer.
- **Real profile photos** for contacts and groups, with a colored-initials
  fallback.

## QR codes

- **Show your code**: **Settings → Profile → Edit profile → My QR code** renders
  your Signal username link as a QR code. If you have no username yet, the app
  asks for one first (created on Signal, link cached on the phone). SoftLeft
  opens the link directly.
- **Scan a code**: **New chat → SoftLeft**, point the camera at a QR. A phone
  number drops into the field ready to start a chat; anything else is placed
  there for you to review.

Both are **best-effort on KaiOS 2.5** — camera and decoder support vary by
device, and the app backs out cleanly when scanning isn't available.

## Starting a new chat

Press **SoftRight** on the list to open **New chat**:

- **Search as you type** to filter your contacts and groups.
- **Start by number or username** — pick "Start chat with …". Phone numbers are
  checked against the Signal directory first, so you know immediately if one
  isn't registered.
- **Scan a QR code** — SoftLeft (see [QR codes](#qr-codes)).

## Organizing chats

Conversation info and actions live under the list's **SoftLeft → Options** menu
("Contact info" or "Group info").

- **Pin** a chat to the top (see [Pinning](#pinning)).
- **Archive** — archived chats hide behind the "Archived chats" row. A new
  message brings a chat back, **unless it's also muted** and **Keep muted chats
  archived** is on (the default, matching Signal). Turn that off in
  **Settings → Chats** to let muted chats resurface.
- **Mute** — keeps counting unread but stops notifications (🔇).

Archive, mute, and pin state is **local to this phone** — the REST API doesn't
expose Signal's synced chat-list state.

## Contacts and your profile

**Contact info** on a direct chat lets you **rename the contact** (saved on
Signal and synced to your devices), set
[disappearing messages](#disappearing-messages), and **verify their safety
number**.

Edit **your own** profile in **Settings → Profile → Edit profile**: set your
display name or "about", or open **My QR code** (see [QR codes](#qr-codes)). The
REST API can't *read* your current profile back, so the editors pre-fill from
what you last set here (your name may also be seeded from this account's
directory entry). Signal requires a name on every profile change, so set your
**Name** before or together with **About** — a name-only save won't erase an
"about" set elsewhere.

## Groups

**Group info** on a group chat shows members and description, and lets you:

- **Manage members** on their own screen — Center on anyone for **Message**,
  **Make admin** / **Remove admin**, and **Remove from group** (admins are
  badged). SoftLeft **adds a member** by number or username.
- **Rename** the group or **edit its description** (open description links with
  Center).
- **Set [disappearing messages](#disappearing-messages)** for the group.
- **Permissions** — who can add members, edit the group, and send messages
  (Everyone or Only admins).
- **Group link** — turn the invite link off / on / on-with-admin-approval, and
  open the current link to share it.
- **Block the group**, or **Leave** it (both archive it here).

Member, admin, permission, link, and block changes go through Signal and apply
group-wide, subject to your admin rights (the server rejects actions you can't
make).

## Blocking

**Settings → Blocked** lists everyone currently blocked — people and groups — as
reported by the server. It's **read-only** here:

- **Block a group** from its **Group info → Block group**.
- **Blocking/unblocking a person**, and **unblocking a group**, must be done from
  the Signal app or another linked device — the REST API doesn't expose those.

## Accounts

**Settings → Accounts → Switch account** lists your saved numbers and lets you
**Add account**. Each keeps its **own local history**, so switching is clean —
the app reloads into the account you pick.

## Search

Local, case-insensitive substring search across all message history on the phone
(**SoftLeft → Options → Search messages**). Open a result and the app jumps
straight to that message, paging back through history until it's on screen.

## Settings

Grouped into sections; SoftLeft anywhere in Settings jumps to **My QR code**.

- **Server** — server URL, your number, optional reverse-proxy credentials, plus
  Save and Test connection.
- **Privacy** — read receipts, typing indicators, and **Blocked** (see
  [Blocking](#blocking)).
- **Chats** — **Keep muted chats archived** (on by default).
- **Composer** — the text-formatting (markdown) toggle.
- **Profile** — edit name/about and **My QR code** (see [QR codes](#qr-codes)).
- **Accounts** — switch or add accounts.
- **Data** — refresh contacts & groups, the debug log, and Clear local data.

## Notifications and reconnect

Backgrounded, new messages raise a system notification (unless muted); group
notifications are prefixed with the sender's name.

If the connection drops or the app is suspended, it retries with backoff,
reconnects on foreground, and uses a periodic wake alarm to reconnect on its own.
There's no server-side history to replay, so anything delivered while fully
offline can't be backfilled.

## What lives on the phone

Message history lives on the phone in IndexedDB — the REST API has no history
endpoint, so history accrues from the moment you start using the app and is
pruned to about **500 messages per conversation**; viewed media sits in a small
LRU cache. Wipe everything with **Settings → Clear local data**. For how this
works under the hood, see [Architecture](architecture.md).

## Troubleshooting

Start at **Settings → Debug log** — a ring buffer of the last ~150 diagnostic
lines (envelope shapes, network errors, WebSocket connect/close). Common cases:

- **Nothing connects / "Network error".** Check **Server URL** and run **Test
  connection**. The server must be reachable from the phone and in `json-rpc`
  mode.
- **HTTP works but live messages never arrive**, with proxy auth configured —
  the WebSocket + Basic Auth limitation. Authenticate the `/v1/receive` path with
  a receive token (or exempt it): see [Remote access](remote-access.md). The app
  also shows a one-time "blocked by the proxy auth" toast when it detects this.
- **A specific message/reaction/receipt didn't render.** Look for a
  `normalize: unhandled …` line — unknown envelope shapes are logged, not
  crashed.
- **Old messages are missing.** Expected — see
  [What lives on the phone](#what-lives-on-the-phone).
- **Messages vanished on their own.** A disappearing-message timer is set; check
  **Contact/Group info → Disappearing messages**.
- **QR scanning doesn't work.** It tries a live camera stream (`getUserMedia`,
  gated by `video-capture`) and falls back to snapping a photo with the OS camera
  and decoding that. Re-sideload after the `video-capture` permission was added;
  if live preview never appears, the snapshot path still works wherever the photo
  picker does.
