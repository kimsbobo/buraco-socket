# Core Runtime (`src`)

This is the production runtime for the Brazilia realtime server.

## High-level architecture

- `index.js`: server bootstrap (HTTP + Socket.IO + inbound webhook routes)
- `handlers/`: socket event orchestration and room synchronization methods
- `services/`: room and matchmaking orchestration
- `models/`: domain state objects (`GameRoom`, `PlayerSession`, `Deck/Card`)
- `validators/`: game rule validation for every action
- `managers/`: failure/recovery subsystem
- `integrations/`: outbound webhook relay to partner backend
- `middleware/`: error wrapping + socket rate limiting
- `constants/`: canonical event names and statuses
- `utils/`: logger and helper infrastructure

## Request flow summary

1. Backend syncs room via `/webhooks/sync-room`
2. Clients connect and emit `join_room`
3. Start game via host action or `/webhooks/start-game`
4. Gameplay actions (`draw_card`, `play_meld`, `discard_card`, etc.)
5. State updates broadcast via `game_state_update` and atomic events
6. Reliability managed by `FailureManager`
