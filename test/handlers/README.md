# Handler Tests

Tests for socket orchestration behavior.

## File

- `SocketHandlers.test.js`

## Validated behavior

- Reject joining a room that has not been synced into memory
- `triggerStartGame` idempotency when room is already in progress
- `syncRoomFromBackend` room mutation (ruleset, host, skins, capacity)
- `getRoomRuntimeSnapshot` for missing rooms
- Reconnection path through `FailureManager`
