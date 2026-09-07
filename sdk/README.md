# SDK Layer

This folder exposes an embeddable Node.js SDK wrapper around the game server domain.

## Purpose

- Provide a programmatic API (`BraziliaSDK`) for host applications
- Emit high-level internal events like `game.started`, `game.completed`, `player.status`
- Re-export useful constants from core server modules

## Files

- `BraziliaSDK.js`  
  Main SDK class with lifecycle (`start`, `stop`), event subscriptions (`on`, `off`), and state/stat APIs.

- `index.js`  
  Entry point exporting `BraziliaSDK`, `GameRoomStatus`, and `SocketEvents`.

- `events/`  
  Lightweight event emitter abstraction for SDK consumers.

- `example/`  
  Minimal server integration example.

## Important context

This SDK is a wrapper convenience layer. The primary production runtime path remains `src/index.js` with HTTP + Socket.IO + webhook integration.
