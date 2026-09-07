# Managers

Contains advanced orchestration modules beyond basic room/game services.

## File

- `FailureManager.js`

## Responsibilities

- Reconnection flow with previous socket session tracking
- Grace period handling on disconnects
- Bot conversion hooks for leavers (architecture present)
- Host migration coordination
- Runtime game snapshot persistence to Redis-like store
- Restore persisted games on server startup

## Storage

By default this project wires `FailureManager` to `InMemoryRedis` (`src/utils/InMemoryRedis.js`).  
The API is Redis-compatible for methods used (`setex`, `get`, `keys`, `del`, `exists`).
