# Realtime Direct Messages (Social DM) — Integration Contract

**Issue:** PTW-50 (parent PTW-36 P1-4) — move mobile social chat off 5s HTTP polling onto realtime.

This reuses the **existing game socket server** (`ws-buraco.wblue.id`) rather than adding a
separate broadcasting stack (Reverb/Echo). No new client dependency is needed — the mobile
already speaks Socket.IO to this server for in-game play.

## How it works

1. The mobile connects to the socket server with the user's backend bearer token (same handshake
   the game already uses). On connect, an **authenticated** socket is auto-joined to a per-user
   room `user:{userId}` (server-side; the client does nothing for this).
2. On `POST /messages`, the backend creates the `Message`, then POSTs
   `/webhooks/direct-message` to the socket server (best-effort, 3s timeout, secret-guarded).
3. The socket server emits a `direct_message` event to the recipient's `user:{userId}` room
   (and the sender's room, for multi-device read-consistency). The Redis adapter (when enabled)
   fans this out cross-node, so it works regardless of which instance each user is connected to.

```
POST /messages ──► Backend (create Message) ──webhook──► Socket server ──emit──► recipient devices
                          │                                                       sender's other devices
                          └──HTTP 200 (message)──► sender (this device)
```

## Client connect + auth handshake

Use the **same** authenticated Socket.IO connection as the game (one socket per app session is
enough — DMs and game events share it). Pass the Sanctum bearer token in the handshake `auth`:

```dart
final socket = io(
  'https://ws-buraco.wblue.id',
  OptionBuilder()
    .setTransports(['websocket'])
    .setAuth({'token': bearerToken}) // same token used for the REST API
    .build(),
);
```

The server verifies the token against the backend `GET /api/me` and binds the connection to the
server-resolved user id. **A user-level connection requires a valid token** — without one the
socket connects in legacy mode and will NOT join `user:{userId}`, so it receives no DMs.

> No explicit "subscribe" call is required. Joining `user:{userId}` happens automatically on an
> authenticated connect. The client only needs to listen for the event.

## Event the client listens for

| Event            | Direction       | When                                  |
|------------------|-----------------|---------------------------------------|
| `direct_message` | server → client | A new DM was created (recipient/sender)|

### Payload

The payload is the **full message** in the same shape as the `POST /messages` response and the
`GET /conversations/{id}/messages` history items, so it can be appended without a second transform:

```json
{
  "id": 123,
  "conversation_id": 45,
  "sender_id": 7,
  "content": "hey!",
  "is_read": false,
  "created_at": "2026-06-11T16:20:51.000000Z",
  "updated_at": "2026-06-11T16:20:51.000000Z",
  "sender": {
    "id": 7,
    "name": "...",
    "profile": { ... }
  }
}
```

## Client integration steps (mobile, PTW-36)

1. On chat open: keep the existing one-shot `GET /conversations/{id}/messages` fetch (initial load
   + on resume). **Drop the 5s poll.**
2. Listen for `direct_message`. On each event:
   - If `conversation_id` matches the open conversation → append to the message list.
   - **De-dupe by `id`** before appending — the sending device also receives the event (sender
     room echo), and it already has the message from the `POST /messages` response.
   - For conversations that are not open, use it to bump unread badges / conversation list ordering.
3. Offline tolerance: if the socket was disconnected when a DM arrived, the on-open/on-resume
   history fetch backfills it. Realtime is an optimization, not the source of truth.

## Notes / guarantees

- **Existing REST endpoints are unchanged.** `POST /messages` and
  `GET /conversations/{id}/messages` behave exactly as before.
- **Best-effort delivery.** A socket outage never fails the send (the backend swallows webhook
  errors and logs a warning). Always reconcile with the history fetch on open/resume.
- **Security.** The webhook is guarded by `x-webhook-secret` (`WEBHOOK_SECRET`), the same shared
  secret used by the room webhooks. Recipient targeting is server-side by user id — clients cannot
  request another user's stream.

## Backend / ops config

- `SOCKET_SERVER_URL` — base URL the backend POSTs the webhook to (default `http://localhost:8080`).
- `WEBHOOK_SECRET` — shared secret; required in production (boot validation).
- Socket auth must be reachable (`BACKEND_URL` / `/api/me`) for user rooms to bind.
