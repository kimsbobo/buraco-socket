# Test Suite

This directory contains the automated tests for the socket server runtime.

## Current test files

- `game_service_host_migration.test.js`
- `game_validator.test.js`
- `handlers/SocketHandlers.test.js`
- `models/GameRoom.test.js`
- `services/GameService.test.js`
- `validators/GameValidator.test.js`

## Focus areas covered

- Room creation/reuse and room ID normalization
- Player join/reconnect/leave logic
- Host migration behavior
- Validator constraints and action legality
- Socket handler behaviors for:
  - room sync from backend webhook data
  - runtime snapshot generation
  - guarded join behavior when room not synchronized
  - start-game idempotency in already-active rooms
  - reconnection path through `FailureManager`

## Run tests

```bash
npm test
npm run test:watch
npm run test:coverage
```

Run a single file:

```bash
npx mocha test/services/GameService.test.js --timeout 5000
```

## Notes

- Stack: Mocha + Chai
- Test timeout default in package scripts: `5000ms`
- Prefer colocating new tests in the matching subdirectory (`handlers`, `models`, `services`, `validators`)
