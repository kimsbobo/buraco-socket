/**
 * A PLAIN REJOIN MUST RELEASE THE GRACE RECORD.
 *
 * FailureManager._handleReconnection has always done this — but only for a
 * client that tells the server which socket it lost. The shipped Flutter client
 * never can: socket_io_client sets `Socket.id = null` one line BEFORE it emits
 * `disconnect`, so the id the client tries to capture is always null and
 * `join_room.previousSocketId` is always absent. The entire recovery branch
 * (grace-key deletion, grace-timer cancellation, turn-timer resume) was
 * therefore unreachable in production, while the suite looked green because
 * grace_reconnect_no_autoskip.test.js drives it with previousSocketId supplied
 * by hand.
 *
 * Consequence in the field: a player who came back INSIDE the grace window kept
 * a `grace_period` stamp and an armed expiry timer, and that timer eventually
 * converted their occupied seat to a bot.
 *
 * clearGraceForReconnect is the identity-free half of that recovery, keyed on
 * the seat handleJoinRoom has already re-bound.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const FailureManager = require('../../src/managers/FailureManager');
const GameService = require('../../src/services/GameService');

const noopLogger = { info() {}, warn() {}, debug() {}, error() {} };

function fakeRedis() {
  const store = new Map();
  return {
    store,
    async setex(key, _ttl, val) { store.set(key, val); },
    async set(key, val) { store.set(key, val); },
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async del(key) { store.delete(key); },
    async exists(key) { return store.has(key) ? 1 : 0; },
    async keys() { return Array.from(store.keys()); },
  };
}

function fakeSocket(id, emitted) {
  return {
    id,
    join: () => {},
    leave: () => {},
    emit: (event, payload) => emitted.push({ to: id, event, payload }),
    to: (roomId) => ({ emit: (event, payload) => emitted.push({ roomId, event, payload }) }),
  };
}

function table() {
  const emitted = [];
  const registry = new Map();
  const service = new GameService();
  const io = {
    to: (roomId) => ({ emit: (event, payload) => emitted.push({ roomId, event, payload }) }),
    sockets: { sockets: registry },
  };
  const redis = fakeRedis();
  const failureManager = new FailureManager(io, redis, service, noopLogger);
  const handlers = new SocketHandlers(io, service, null, failureManager);

  const room = service.createRoom('grace-plain', 2);
  service.joinRoom('grace-plain', 'p1', 'P1', 's-p1');
  service.joinRoom('grace-plain', 'p2', 'P2', 's-p2');
  room.startGame();
  room.dealCards();
  room.currentTurn = 0;
  handlers._stopTurnTimer(room);
  registry.set('s-p1', fakeSocket('s-p1', emitted));
  registry.set('s-p2', fakeSocket('s-p2', emitted));

  return { service, room, handlers, failureManager, redis, emitted, registry };
}

describe('#a rejoin with no previousSocketId still releases grace', () => {
  const cleanups = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()();
  });

  function track(ctx) {
    cleanups.push(() => {
      ctx.failureManager.dispose();
      ctx.service.shutdown();
    });
    return ctx;
  }

  it('clears the redis marker, the expiry timer and the grace_period stamp', async () => {
    const ctx = track(table());

    await ctx.failureManager.handlePlayerDisconnection({ id: 's-p1' }, 'p1', 'grace-plain');
    expect(await ctx.redis.get('grace:p1:grace-plain'), 'grace really entered').to.not.equal(null);
    expect(ctx.failureManager.graceTimers.has('grace:p1:grace-plain')).to.equal(true);
    // _enterGracePeriod stamps 'grace_period' and then calls player.disconnect(),
    // which overwrites it — the redis marker above is the real record.
    expect(ctx.room.getPlayer('p1').status).to.equal('disconnected');
    expect(ctx.room.getPlayer('p1').socketId).to.equal(null);

    // The rejoin the real client sends: playerId only, NO previousSocketId.
    const back = fakeSocket('s-p1-new', ctx.emitted);
    ctx.registry.set('s-p1-new', back);
    await ctx.handlers.handleJoinRoom(back, {
      roomId: 'grace-plain',
      playerId: 'p1',
      playerName: 'P1',
    });

    const p1 = ctx.room.getPlayer('p1');
    expect(p1.socketId).to.equal('s-p1-new');
    expect(p1.status, 'the stamp is lifted').to.equal('connected');
    expect(p1.isConnected).to.equal(true);
    expect(
      await ctx.redis.get('grace:p1:grace-plain'),
      'the marker is deleted'
    ).to.equal(null);
    expect(
      ctx.failureManager.graceTimers.has('grace:p1:grace-plain'),
      'and the bot-conversion timer is cancelled'
    ).to.equal(false);
    expect(
      ctx.emitted.some((e) => e.to === 's-p1-new' && e.event === 'game_state_update'),
      'the returning player is sent the board'
    ).to.equal(true);
  });

  it('resumes the turn timer when the returning player is the one on turn', async () => {
    const ctx = track(table());
    const resumed = [];
    ctx.failureManager.turnTimerControl = {
      pause: () => {},
      resume: (room) => resumed.push(room.roomId),
    };

    await ctx.failureManager.handlePlayerDisconnection({ id: 's-p1' }, 'p1', 'grace-plain');

    const back = fakeSocket('s-p1-new', ctx.emitted);
    ctx.registry.set('s-p1-new', back);
    await ctx.handlers.handleJoinRoom(back, {
      roomId: 'grace-plain',
      playerId: 'p1',
      playerName: 'P1',
    });

    expect(resumed, 'p1 is seat 0 and it is seat 0\'s turn').to.deep.equal(['grace-plain']);
  });

  it('is a no-op for a rejoin that was never in grace', async () => {
    const ctx = track(table());

    const back = fakeSocket('s-p1-new', ctx.emitted);
    ctx.registry.set('s-p1-new', back);
    await ctx.handlers.handleJoinRoom(back, {
      roomId: 'grace-plain',
      playerId: 'p1',
      playerName: 'P1',
    });

    expect(ctx.room.getPlayer('p1').status).to.equal('connected');
    expect(await ctx.redis.get('grace:p1:grace-plain')).to.equal(null);
  });
});
