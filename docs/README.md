# signal4kaios documentation

A Signal messenger client for **KaiOS 2.5** feature phones, powered by a
self-hosted [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api)
server on your network. Written in vanilla JavaScript with **zero build step**
and packaged as a **privileged** KaiOS app.

This is the documentation wiki. Start with whichever section fits what you're
doing.

## For users

- **[Getting started](getting-started.md)** — what you need, how to set up the
  server, sideload the app onto your phone, and configure it on first run.
- **[User guide](user-guide.md)** — every feature explained, plus the full
  keypad reference for navigating the app.
- **[Remote access](remote-access.md)** — reaching your server away from home
  with a reverse proxy and HTTP Basic Auth, and the one WebSocket caveat you
  need to know about.
- **[Troubleshooting](#troubleshooting)** — see below.

## For developers

- **[Architecture](architecture.md)** — how the app is put together: the
  receive/send data flow, the module reference, the IndexedDB schema, and the
  normalized event shapes.
- **[Development](development.md)** — the Gecko 48 constraints, packaging,
  desktop development, code conventions, and how to add a new screen.
- **[AGENTS.md](../AGENTS.md)** — the condensed rules for AI coding agents (and a
  fast orientation for humans, too).

## How the pieces fit together

```
                            your home network / a reverse proxy
                                          │
   ┌───────────────┐   HTTP + WebSocket   │   ┌───────────────────────┐
   │  signal4kaios │◀────────────────────▶│──▶│  signal-cli-rest-api   │──▶ Signal
   │  (KaiOS app)  │                       │   │  (json-rpc mode)       │
   └───────────────┘                       │   └───────────────────────┘
```

The app is only a client. Your Signal account lives on the signal-cli-rest-api
server, which must be **registered or linked** and running in **`json-rpc`**
mode. The phone reaches it either directly over Wi-Fi or through a reverse proxy
(see [Remote access](remote-access.md)).

## Quick reference

| I want to… | Go to |
|---|---|
| Install the app on my phone | [Getting started → Install](getting-started.md#2-install-sideload) |
| Learn the keys | [User guide → Keys](user-guide.md#keys) |
| Use it away from home | [Remote access](remote-access.md) |
| Understand the code | [Architecture](architecture.md) |
| Make a change safely | [Development](development.md) |

## Troubleshooting

Most "why isn't this working?" answers start in the same place:

**Settings → Debug log.** The app keeps a ring buffer of the last ~150
diagnostic lines — unhandled envelope shapes, network errors, WebSocket
connect/close events, and more. It is the first place to look when a message
doesn't appear or the connection won't stay up.

Common cases:

- **Nothing connects / "Network error".** Check the **Server URL** in Settings
  and run **Test connection**. The server must be reachable from the phone and
  running in `json-rpc` mode.
- **HTTP works but live messages never arrive**, and you configured proxy auth:
  this is the WebSocket + Basic Auth limitation. Fix it by authenticating the
  `/v1/receive` path with a **Receive token** (or exempting it) — see
  [Remote access](remote-access.md). The app also shows a one-time toast
  ("blocked by the proxy auth") when it detects this pattern.
- **A specific message/reaction/receipt didn't render.** Look for a
  `normalize: unhandled …` line in the debug log — envelope shapes vary across
  signal-cli versions and unknown ones are logged rather than crashing.
- **Old messages are missing.** Expected: there is no server history API, so
  history only accrues from when you started using the app, and each
  conversation is pruned to ~500 messages.
- **Messages vanished on their own.** If the chat has a disappearing-message
  timer, messages are deleted once it elapses (enforced locally on a periodic
  sweep and on chat open). Check the timer under **Contact/Group info →
  Disappearing messages**.
- **QR scanning doesn't work.** It first tries a live camera stream
  (`getUserMedia`, gated by the `video-capture` permission) and, if the device
  won't grant one, falls back to snapping a photo with the OS camera and
  decoding that. Re-sideload after the `video-capture` permission was added; if
  live preview never appears, the snapshot path still works wherever the photo
  picker does.
