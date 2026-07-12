# User guide

Everything the app can do, and how to drive it from the keypad. It's all buttons
here — no touchscreen required, no touchscreen wanted.

- [Keys](#keys)
- [The conversation list](#the-conversation-list)
- [Inside a chat](#inside-a-chat)
- [Messaging features](#messaging-features)
- [Starting a new chat](#starting-a-new-chat)
- [Media and attachments](#media-and-attachments)
- [Organizing chats](#organizing-chats)
- [Contacts and your profile](#contacts-and-your-profile)
- [Groups](#groups)
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
| **Center** | Open chat (or the archived list) | Send (composer) · message options (on a message) |
| **SoftLeft** | Options: info, archive, mute, search, settings | Emoji picker (composer) · cancel reply / cancel edit |
| **SoftRight** | New chat | Attach photo |
| **Back** | Exit app | Back to the list |

In the composer, **SoftLeft** opens the emoji picker — until you're replying or
editing, when it becomes the cancel key instead.

Context-specific keys:

- **Message options menu** (Center on a message): view photo/attachment, react,
  reply, copy to composer, edit, delete for everyone, retry, see who reacted,
  and an info line (full timestamp + delivery status).
- **Attachment viewer**: Center plays/pauses audio; **SoftLeft** saves the file
  to the phone.
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
indicator, and a 🔇 **muted** icon.

The header shows the connection status: `● online`, `connecting…`, or `offline`.

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
- **Read receipts and typing indicators** — and if you'd rather not send read
  receipts, switch them off in **Settings → Privacy** (you'll still see others').
- **Quote / reply**, **copy to composer**, and **delete for everyone**.
- **Edit sent messages** — and see edits made by others, or by you on another
  linked device.
- **Read status syncs across your devices** — reading a chat on Signal Desktop
  clears its unread badge here too.
- **Retry failed sends.**

## Starting a new chat

Press **SoftRight** on the conversation list to open **New chat**. From there:

- **Search as you type** to filter your contacts and groups — no need to scroll
  the whole address book.
- **Start by number or username**: type a phone number or a Signal username and
  pick "Start chat with …". Phone numbers are checked against the Signal
  directory first, so you'll know right away if a number isn't registered.

## Media and attachments

- **Inline photo thumbnails** in chat. Small images auto-download for inline
  view; all viewed media is cached offline in IndexedDB. A full-screen viewer is
  available from the message options.
- **Send photos from the gallery** via the system picker; images are downscaled
  on-device before upload to keep memory in check.
- **Voice messages and audio** play in the viewer.
- **Save any attachment to the phone** (gallery / music / files via
  DeviceStorage) with SoftLeft in the viewer.
- **Real profile photos** for contacts and groups, with a colored-initials
  fallback.

## Organizing chats

- **Archived chats** are hidden behind the "Archived chats" row. A new message
  brings a chat back to the main list — **unless it's also muted**, matching
  Signal's behavior. Archive/mute state is **local to this phone**: the REST API
  does not expose Signal's synced chat-list state.
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
- **Verify their safety number** — view the fingerprint and mark it verified.

To edit **your own** profile, go to **Settings → Profile → Edit profile** and set
your display name or "about" text.

## Groups

**SoftLeft → Options → Group info** on a group chat shows its members and
description, and lets you:

- **Rename the group** or **edit its description**.
- **Leave the group** (it's archived here afterward).

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

Settings is grouped into sections so it's easy to scan:

- **Server** — server URL, your Signal number, optional reverse-proxy
  credentials, plus **Save** and **Test connection**.
- **Privacy** — the read-receipts toggle.
- **Profile** — edit your Signal name / about.
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
