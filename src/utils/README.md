# Utilities

Shared helper infrastructure.

## Files

- `logger.js`  
  Singleton logger with level filtering, optional file output, and colorized console logs.

- `InMemoryRedis.js`  
  Lightweight in-memory Redis-like adapter used by `FailureManager`.

- `MessageSequencer.js`  
  Per-room sequence number helper for ordered message metadata.

- `index.js`  
  Utility exports.

## Operational note

For distributed production deployments, replace in-memory stores with centralized infrastructure.
