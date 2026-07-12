# Roadmap

Features that are **not yet implemented**, with pointers for how each could be
built. These are ideas, not commitments. Endpoints refer to
[signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api); new work
must respect the [Gecko 48 constraints](development.md#gecko-48-constraints).

| Feature | Notes for implementation |
|---|---|
| **Group info & management** | Show members/description (`GET /v1/groups/{number}/{groupid}`); create / update / leave |
| **Safety numbers** | List & verify via `/v1/identities/{number}` |
| **Profile editing** | Set own name/avatar via `PUT /v1/profiles/{number}` |
| **Polls** | Render incoming polls; create/vote via `/v1/polls/{number}` |
| **Sticker packs** | Render incoming stickers; manage via `/v1/sticker-packs/{number}` |
| **Registered-number check** | `GET /v1/search` to validate manually entered numbers in New chat |
| **Contact management** | Rename via `PUT /v1/contacts/{number}` + `/sync` |
| **Jump-to-message from search** | Pass a target timestamp to the chat screen and page until reached |
| **History backfill** | No REST API for history — would need a companion export/import script on the server |
| **Multi-account** | Per-account IndexedDB database + account switcher in Settings |
| **Reconnect hardening** | `alarms` permission to wake the app and reconnect the WebSocket |

See [Architecture](architecture.md) for where each piece would slot in, and
[Development → Adding a screen](development.md#adding-a-screen) for new UI.
