# Socket and Action Handlers

This directory is the orchestration layer between socket events and game domain logic.

## Files

- `SocketHandlers.js`  
  Main gateway for all player/spectator socket events, room join/leave, start/deal, game actions, matchmaking wiring, and webhook helper methods (`triggerStartGame`, `syncRoomFromBackend`, `getRoomRuntimeSnapshot`).

- `ActionHandlers.js`  
  Action-level command handlers (`draw`, `meld`, `discard`, `go down`, etc.), round finalization, and payload shaping.

- `index.js`  
  Export entry for handler modules.

## Runtime role

`SocketHandlers` coordinates:

- Validation + state mutation + broadcast ordering
- Reconnection/degradation behavior integration with `FailureManager`
- Outbound partner webhook event emission
