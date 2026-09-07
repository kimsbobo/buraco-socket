/**
 * The connection-level rate limiter (io.use) runs only once per handshake, so a
 * connected client could spam game actions unbounded. checkActionLimit() adds a
 * per-socket per-event flood guard, and SocketHandlers._actionGuard emits a
 * RATE_LIMITED error (without disconnecting) when a socket floods.
 */

const { expect } = require('chai');
const rateLimiter = require('../../src/middleware/rateLimiter');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const { SocketEvents } = require('../../src/constants');

describe('#per-event action rate limit', () => {
  it('allows up to the cap then blocks within the window', () => {
    const id = 'flood-sock-1';
    rateLimiter.reset(id);
    const max = rateLimiter.maxActionsPerWindow;

    let allowed = 0;
    for (let i = 0; i < max; i++) {
      if (rateLimiter.checkActionLimit(id)) allowed++;
    }
    expect(allowed).to.equal(max);
    // The next one in the same window is blocked.
    expect(rateLimiter.checkActionLimit(id)).to.equal(false);

    rateLimiter.reset(id);
  });

  it('reset() clears the action counter', () => {
    const id = 'flood-sock-2';
    rateLimiter.reset(id);
    for (let i = 0; i < rateLimiter.maxActionsPerWindow; i++) rateLimiter.checkActionLimit(id);
    expect(rateLimiter.checkActionLimit(id)).to.equal(false);
    rateLimiter.reset(id);
    expect(rateLimiter.checkActionLimit(id)).to.equal(true);
    rateLimiter.reset(id);
  });

  it('does not touch the connection-level bucket', () => {
    const id = 'flood-sock-3';
    rateLimiter.reset(id);
    // Exhaust the action bucket.
    for (let i = 0; i < rateLimiter.maxActionsPerWindow + 5; i++) rateLimiter.checkActionLimit(id);
    // The connection bucket is independent and still has capacity.
    expect(rateLimiter.checkLimit(id)).to.equal(true);
    rateLimiter.reset(id);
  });

  it('_actionGuard emits RATE_LIMITED and stops calling the handler when flooded', () => {
    const id = 'guard-sock-1';
    rateLimiter.reset(id);
    const emitted = [];
    const socket = { id, emit: (event, payload) => emitted.push({ event, payload }) };
    const handlers = new SocketHandlers(
      { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } },
      new GameService()
    );

    let handlerCalls = 0;
    const guarded = handlers._actionGuard(socket, () => { handlerCalls++; });

    const total = rateLimiter.maxActionsPerWindow + 10;
    for (let i = 0; i < total; i++) guarded({});

    // Handler ran only up to the cap; the rest were dropped.
    expect(handlerCalls).to.equal(rateLimiter.maxActionsPerWindow);
    const rateLimited = emitted.filter(
      (e) => e.event === SocketEvents.ERROR && e.payload.code === 'RATE_LIMITED'
    );
    expect(rateLimited.length).to.equal(10);

    rateLimiter.reset(id);
  });
});
