# User guide

Everything the app can do, and how to drive it from the keypad. It's all buttons
here — no touchscreen required, no touchscreen wanted.

- [Keys](#keys)
- [The conversation list](#the-conversation-list)
- [Inside a chat](#inside-a-chat)
- [Messaging features](#messaging-features)
- [Disappearing messages](#disappearing-messages)
- [Pinning](#pinning)
- [Starting a new chat](#starting-a-new-chat)
- [Media and attachments](#media-and-attachments)
- [QR codes](#qr-codes)
- [Organizing chats](#organizing-chats)
- [Contacts and your profile](#contacts-and-your-profile)
- [Groups](#groups)
- [Blocking](#blocking)
- [Accounts](#accounts)
- [Search](#search)
- [Settings](#settings)
- [Notifications](#notifications)
- [What lives on the phone](#what-lives-on-the-phone)

## Keys

The app is fully keypad-driven. There is no touch requirement.

| Key | Conversation list | Inside a chat |
|---|---|---|
| **Up / Down** | Move the selection | Move through messages / composer |
| **Center** | Open chat (or the archived list) | Send (composer) · message options (on a message) · view pinned (on the pinned bar) |
| **SoftLeft** | Options: info, pin, archive, mute, search, settings | Emoji picker (composer) · cancel reply / cancel edit |
| **SoftRight** | New chat | Attach a file (opens the system picker) |
| **Back** | Exit app | Back to the list |

In the composer, **SoftLeft** opens the emoji picker — until you're replying or
editing, when it becomes the cancel key instead.

Context-specific keys:

- **Message options menu** (Center on a message): view photo/attachment, open
  any links in it (they open in the browser), react, reply, copy to composer,
  pin/unpin (groups only), edit, delete for everyone, retry, see who reacted,
  and an info line (full timestamp + delivery status, plus the disappearing
  countdown when a timer is set).
- **Attachment viewer**: Center plays/pauses audio and video; **SoftLeft** saves
  the file to the phone.
- **Attach a file** (SoftRight in the composer): opens the KaiOS system picker,
  which itself offers Camera, Recorder, Gallery, Video, and any file.
- **New chat**: **SoftLeft** opens the **QR scanner**.
- **Archived list**: its own **SoftLeft** menu (unarchive, mute).
- **Reaction / emoji picker**: a grid of common emoji; Center picks the
  highlighted one. In the reaction picker a "Remove my reaction" row appears if
  you've already reacted.

Note: KaiOS's Back key is delivered as Backspace. In a non-empty text field it
edits text; otherwise it goes back a screen.

## The conversation list

The home screen. Each row shows an avatar (real profile photo when available,
otherwise colored initials), the name, the time of the last activity, a preview
of the last message, and — when relevant — an **unread badge**, a **typing**
indicator, a 📌 **pinned** icon, and a 🔇 **muted** icon. Pinned chats sort to
the top of the list.

The header shows the connection status: `● online`, `connecting…`, or `offline`.

A chat with your own number shows as **Note to Self** with a 📔 notebook icon,
just like on other Signal clients — handy for jotting things to yourself.

If any chats are archived, an **"📁 Archived chats"** row appears at the bottom;
open it to see them.

## Inside a chat

Messages appear oldest at the top, newest at the bottom, with the composer
below. Names in group chats are resolved from your address book, nicknames, and
Signal profiles. Scrolling up pages in older history from the phone's storage.

**Delivery ticks** on your outgoing messages progress through:

```
pending → sent ✓ → delivered ✓✓ → read (blue)
```

Failed sends are marked so you can retry them from the message options menu.

## Messaging features

- **Send & receive text in real time** — receive is over the WebSocket
  (`json-rpc` mode).
- **1:1 and group chats.**
- **Emoji in the composer** — SoftLeft opens a picker; the chosen emoji drops in
  at your cursor.
- **Reactions** — a grid of common emoji (well beyond the classic
  ❤️ 👍 👎 😂 😮 😢), with a remove option. Pick **Reactions** from a message's
  options to see exactly who reacted and with what.
- **Read receipts and typing indicators** — switch either off in
  **Settings → Privacy** if you'd rather not send them (you'll still see
  others').
- **Formatted text** — type Signal's markers and they're sent as real
  formatting: `**bold**`, `*italic*`, `~strikethrough~`, `` `monospace` ``, and
  `||spoiler||` (highlight a message to reveal its spoilers). Prefix a marker
  with `\` to type it literally. Underline isn't something Signal supports.
  Formatting others send shows up here too; toggle sending in
  **Settings → Composer → Text formatting**.
- **Quote / reply**, **copy to composer**, and **delete for everyone**.
- **Edit sent messages** — and see edits made by others, or by you on another
  linked device.
- **Read status syncs across your devices** — reading a chat on Signal Desktop
  clears its unread badge here too.
- **Retry failed sends.**

## Disappearing messages

Set a chat's disappearing-message timer from **Contact info** (direct) or
**Group info** (group) → **Disappearing messages**, then pick an interval (Off,
30 seconds, 5 minutes, 1 hour, 8 hours, 1 day, 1 week, or 4 weeks). The change
is applied on Signal, so it takes effect for everyone in the conversation.

- New messages in the chat carry the timer, and the app deletes them from the
  phone once the interval has elapsed. This is enforced locally on a periodic
  sweep as well as when you open the chat.
- To see how long a specific message has left, open its **options → Info** — the
  line shows the full timestamp, delivery status, and "disappears in …" when a
  timer is active.

## Pinning

Two independent kinds of pinning:

- **Pinned messages (groups only).** In a group chat, open a message's
  **options → Pin message**. This uses Signal's group pin feature, so it **syncs
  to everyone** in the group; pins made by others (or by you on another device)
  show up here too. Pinned messages get a 📌 marker, and a **"N pinned"** bar
  appears at the top of the chat — select it to list the pinned messages and
  jump to one. Signal has no 1:1 message-pin, so the action only appears in
  groups.
- **Pinned conversations (local).** From the conversation list's
  **SoftLeft → Options → Pin chat**, pin a chat to the top of your list. This one
  is **local to this phone** (Signal exposes no sync for chat-list pins).

## Starting a new chat

Press **SoftRight** on the conversation list to open **New chat**. From there:

- **Search as you type** to filter your contacts and groups — no need to scroll
  the whole address book.
- **Start by number or username**: type a phone number or a Signal username and
  pick "Start chat with …". Phone numbers are checked against the Signal
  directory first, so you'll know right away if a number isn't registered.
- **Scan a QR code**: press **SoftLeft** to open the camera scanner (see
  [QR codes](#qr-codes)).

## Media and attachments

Press **SoftRight** in the composer to **attach a file**. This opens the KaiOS
system picker, which on real hardware offers Camera, Recorder, Gallery, Video,
and any file on the device. The chosen file is read and sent as-is, keeping its
original filename.

Other media behavior:

- **Inline photo thumbnails** in chat. Small images auto-download for inline
  view; all viewed media is cached offline in IndexedDB. A full-screen viewer is
  available from the message options.
- **Voice messages, audio, and video** play in the viewer — open the message's
  options and choose **Play video** / **Play audio**, then use the center key to
  play/pause. (Video decoding depends on the device's codecs; H.264 MP4 is the
  safe bet on KaiOS.)
- **Save any attachment to the phone** (gallery / music / videos / files via
  DeviceStorage) with SoftLeft in the viewer — this works for any file type.
- **Real profile photos** for contacts and groups, with a colored-initials
  fallback.

## QR codes

- **Show your code**: **Settings → Profile → Edit profile → My QR code** renders
  your Signal username link as a QR code others can scan. If you haven't set a
  username yet, the app asks for one first (it's created on Signal and the
  shareable link is cached on the phone). **SoftLeft** opens the link directly.
- **Scan a code**: from **New chat → SoftLeft**, point the camera at a QR code.
  If it contains a phone number, that number drops into the field ready to
  start a chat; otherwise the raw scanned text is placed there for you to review.

Both are **best-effort on KaiOS 2.5**: camera and decoder support varies by
device, so if scanning isn't available the app tells you and backs out cleanly.

## Organizing chats

- **Pin a chat** to the top of the list from **SoftLeft → Options → Pin chat**
  (📌). Pinned chats always sort above the rest. This is local to this phone.
- **Archived chats** are hidden behind the "Archived chats" row. A new message
  brings a chat back to the main list — **unless it's also muted** and the
  **Keep muted chats archived** option is on (the default, matching Signal). Turn
  that option off in **Settings → Chats** to let muted chats resurface like any
  other. Archive/mute/pin state is **local to this phone**: the REST API does not
  expose Signal's synced chat-list state.
- **Muted chats** keep counting unread but stop showing notifications (🔇).
- **Start new chats** with SoftRight on the list — see
  [Starting a new chat](#starting-a-new-chat).
- **Conversation info** lives under the list's **SoftLeft → Options** menu:
  "Contact info" for a direct chat or "Group info" for a group.

## Contacts and your profile

From the conversation list, **SoftLeft → Options → Contact info** on a direct
chat lets you:

- **Rename the contact** — the new name is saved on Signal and synced to your
  linked devices.
- **Set disappearing messages** — pick an interval; it's applied on Signal for
  the conversation. See [Disappearing messages](#disappearing-messages).
- **Verify their safety number** — view the fingerprint and mark it verified.

To edit **your own** profile, go to **Settings → Profile → Edit profile** and set
your display name or "about" text, or open **My QR code** to share your Signal
link (see [QR codes](#qr-codes)).

The REST API has no way to *read* your current profile back, so the editors are
pre-filled from what you last set on this device (your name may also be seeded
from this account's own directory entry when signal-cli provides it). Signal
requires a name on every profile change, so set your **Name** before or together
with your **About** — a name-only save won't erase an "about" you set elsewhere.

## Groups

**SoftLeft → Options → Group info** on a group chat shows its members and
description, and lets you:

- **View and manage members** on their own scrollable screen. Highlight anyone
  and press Center for their options: **Message** (start a direct chat),
  **Make admin** / **Remove admin**, and **Remove from group**. Admins are
  badged. Press **SoftLeft** to **Add a member** by number or username.
- Open **links in the description** — highlight a URL and press Center to open it
  in the browser.
- **Rename the group** or **edit its description**.
- **Set disappearing messages** for the whole group.
- **Permissions** — choose who can **add members**, **edit the group**, and
  **send messages** (Everyone or Only admins).
- **Group link** — turn the invite link on or off, or on with admin approval,
  and open the current link to share it.
- **Block the group** — stop receiving its messages (it's archived here too).
- **Leave the group** (it's archived here afterward).

Member, admin, permission, link, and block changes all go through Signal, so
they apply for the whole group (subject to your own admin rights — the server
rejects actions you're not allowed to make).

## Blocking

**Settings → Blocked** lists everyone currently blocked — people and groups —
as reported by the server. It's **read-only** here:

- **Block a group** from its **Group info → Block group**.
- **Blocking or unblocking a person**, and **unblocking a group**, has to be
  done from the Signal app or another linked device: the REST API this client
  uses doesn't expose those actions.

## Accounts

Have more than one Signal number? **Settings → Accounts → Switch account** lists
your saved accounts and lets you **Add account**. Each account keeps its **own
local history** on the phone, so switching is clean — the app reloads into the
account you pick.

## Search

Local search across all message history stored on the phone
(SoftLeft → Options → Search messages on the list). It's a case-insensitive
substring match over stored message bodies. Open a result and the app **jumps
straight to that message** in the thread, paging back through history until it's
on screen.

## Settings

Settings is grouped into sections so it's easy to scan. **SoftLeft** anywhere in
Settings jumps straight to **My QR code**:

- **Server** — opens **Server & connection**: server URL, your Signal number,
  optional reverse-proxy credentials, plus **Save** and **Test connection**.
- **Privacy** — toggles for **read receipts** and **typing indicators**, and
  **Blocked** (the read-only blocked list; see [Blocking](#blocking)).
- **Chats** — **Keep muted chats archived** (on by default): whether a new
  message pulls a muted, archived chat back into the list.
- **Composer** — the text-formatting (markdown) toggle.
- **Profile** — edit your Signal name / about, and **My QR code**
  (see [QR codes](#qr-codes)).
- **Accounts** — switch between or add accounts.
- **Data** — refresh contacts & groups, the debug log, and **Clear local data**.

## Notifications

When the app is in the background, new messages raise a system notification
(unless the chat is muted). Group notifications are prefixed with the sender's
name.

If the connection drops or the app gets suspended, it retries with backoff,
reconnects when you bring it back to the foreground, and uses a periodic wake
alarm to reconnect on its own — so it catches up on what it can as soon as it's
back online. (There's no server-side history to replay, so anything delivered
while it was fully offline can't be backfilled.)

## What lives on the phone

Message history lives on the phone in IndexedDB — the REST API has no history
endpoint, so history accrues from the moment you start using the app. Old
messages are pruned to about **500 per conversation**, and viewed media is kept
in a small LRU cache. To wipe everything, use **Settings → Clear local data**.

For the details of how this all works under the hood, see
[Architecture](architecture.md).
