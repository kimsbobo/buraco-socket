# Constants

Defines canonical names and statuses used across handlers, services, bots, and tests.

## Files

- `events.js`: Socket.IO event names for connection, room, game lifecycle, and actions
- `matchmaking.js`: matchmaking event/status enums
- `gameStatus.js`: room status values (`waiting`, `inProgress`, `finished`, `abandoned`)
- `index.js`: aggregated export

## Why this matters

Using these constants prevents event name drift between server, bots, tests, and client integrations.
