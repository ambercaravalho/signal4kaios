# User guide

Everything the app can do, and how to drive it from the keypad.

- [Keys](#keys)
- [The conversation list](#the-conversation-list)
- [Inside a chat](#inside-a-chat)
- [Messaging features](#messaging-features)
- [Media and attachments](#media-and-attachments)
- [Organizing chats](#organizing-chats)
- [Search](#search)
- [Notifications](#notifications)
- [What lives on the phone](#what-lives-on-the-phone)

## Keys

The app is fully keypad-driven. There is no touch requirement.

| Key | Conversation list | Inside a chat |
|---|---|---|
| **Up / Down** | Move the selection | Move through messages / composer |
| **Center** | Open chat (or the archived list) | Send (composer) · message options (on a message) |
| **SoftLeft** | Options: archive, mute, search, settings | Cancel reply / cancel edit |
| **SoftRight** | New chat | Attach photo |
| **Back** | Exit app | Back to the list |

Context-specific keys:

- **Message options menu** (Center on a message): view photo/attachment, react,
  reply, copy to composer, edit, delete for everyone, retry, and an info line
  (full timestamp + delivery status).
- **Attachment viewer**: Center plays/pauses audio; **SoftLeft** saves the file
  to the phone.
- **Archived list**: its own **SoftLeft** menu (unarchive, mute).
- **Reaction picker**: Center picks the highlighted emoji; a "Remove my
  reaction" row appears if you've already reacted.

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
- **Reactions** — Signal's six defaults (❤️ 👍 👎 😂 😮 😢), with a remove
  option.
- **Read receipts and typing indicators.**
- **Quote / reply**, **copy to composer**, and **delete for everyone**.
- **Edit sent messages** — and see edits made by others, or by you on another
  linked device.
- **Retry failed sends.**

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
- **Start new chats** from your contact and group list (SoftRight on the list).

## Search

Local search across all message history stored on the phone
(SoftLeft → Options → Search messages on the list). It's a case-insensitive
substring match over stored message bodies.

## Notifications

When the app is in the background, new messages raise a system notification
(unless the chat is muted). Group notifications are prefixed with the sender's
name.

## What lives on the phone

Message history lives on the phone in IndexedDB — the REST API has no history
endpoint, so history accrues from the moment you start using the app. Old
messages are pruned to about **500 per conversation**, and viewed media is kept
in a small LRU cache. To wipe everything, use **Settings → Clear local data**.

For the details of how this all works under the hood, see
[Architecture](architecture.md).
