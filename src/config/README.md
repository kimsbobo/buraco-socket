# Configuration Module

Centralized environment configuration loader.

## File

- `index.js`

## Responsibilities

- Load `.env` with `dotenv`
- Build typed config object for:
  - Server (`port`, `host`, `environment`)
  - Socket.IO (`cors`, ping settings)
  - Game rules and cleanup timers
  - Logging controls
  - Security (`rateLimit`, `webhookSecret`)
  - Outbound partner webhook relay settings

## Integration note

All runtime modules import config from here; environment updates should be reflected here first.
