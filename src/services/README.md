# Services

Service layer for room lifecycle and matchmaking orchestration.

## Files

- `GameService.js`  
  Manages room registry, player-room/socket mappings, join/leave logic, host migration, room cleanup, and statistics.

- `MatchmakingService.js`  
  Queue-based automatic matching with preferences, timeout cleanup, and event emission.

- `index.js`  
  Service exports.

## Runtime importance

`GameService` is the central state coordinator used by `SocketHandlers` and `FailureManager`.
