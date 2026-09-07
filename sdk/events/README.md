# SDK Events

Contains SDK-level event infrastructure.

## File

- `SDKEventEmitter.js`  
  Simple listener map with `on`, `off`, `emit`, and listener counting.

## Why it exists

Decouples SDK event publishing from Node native `EventEmitter` and keeps SDK behavior explicit and portable.
