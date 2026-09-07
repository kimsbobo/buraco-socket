# Bot Toolkit

This directory contains bot clients used for:

- Integration testing against the realtime socket server
- Backend + websocket end-to-end simulation
- Operational smoke tests for full match completion

## Key files

- `BotPlayer.js`  
  Main bot implementation. Connects to Socket.IO server, joins room, reacts to events, and executes gameplay actions.

- `run-bot.js`  
  CLI wrapper to run one bot instance with arguments like `--url`, `--room`, `--name`, `--auto-start`.

- `simulate-plans.js`  
  Advanced simulation orchestrator. Can create/login backend users, create/join/start rooms through backend API, then call socket webhooks.

- `play-until-end.js`  
  Script focused on running a match until completion with bot players.

- `load-soak.js`  
  Phase-6 style multi-room load + reconnect-chaos soak runner.

- `get-token.js`  
  Utility to login to backend API and print access token for local/dev operations.

- `.env`  
  Bot runtime configuration (server URL, backend URL, credentials, delays, etc).

## How to run

```bash
npm run bot
npm run bot:simulate
npm run bot:play
npm run bot:load-soak -- --rooms 6 --players-per-room 2 --runtime-seconds 120 --chaos-interval-ms 5000
```

Pass flags after `--` when needed.

### Load + soak runner (`load-soak.js`)

Phase-6 (PTW-58) validation harness. Creates N synced rooms, joins bots, triggers
backend starts, then runs a fixed-duration soak with periodic reconnect chaos while
polling `/webhooks/room-runtime`. It scores the Phase 0 SLOs and exits non-zero on any
breach so it can gate CI / sign-off.

Measured SLOs (thresholds overridable):

- `connect_success` — % of socket (re)connect attempts that succeed (`--slo-connect-success`, default 99)
- `join_success` — % of bots that complete room join (`--slo-join-success`, default 99)
- `join_p95_latency` — p95 join handshake latency in ms (`--slo-join-p95-ms`, default 2000)
- `reconnect_within_grace` — % of chaos drops that reconnect inside the grace window
  (`--slo-reconnect-success`, default 95; `--reconnect-grace-ms`, default 30000)

```bash
# Single-node baseline + reconnect chaos
npm run bot:load-soak -- --rooms 8 --players-per-room 2 --runtime-seconds 45 --chaos-interval-ms 4000
```

Scope note: this exercises **single-node** load + reconnect chaos, which matches the v1
single-node topology (see PTW-38). Multi-node chaos (kill owner node mid-turn, Redis
outage) requires `replicas > 1` with the Redis adapter enabled — gated OFF in v1 and
tracked under the multi-node ceiling-lift work (PTW-40 / PTW-43).

## Integration role

These scripts are not required by production server runtime, but they are valuable for validating:

- Room synchronization (`/webhooks/sync-room`)
- Backend-triggered starts (`/webhooks/start-game`)
- Reconnection and host migration behavior
- Full match action loops

## Security note

Do not commit real backend credentials or tokens from `.env` into shared repositories.
