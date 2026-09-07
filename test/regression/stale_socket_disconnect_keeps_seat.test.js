/**
 * "RECONNECT ALWAYS LOSES STATE" — the server half.
 *
 * REPORTED LIVE: background the app on a live table, come back, and the board is
 * frozen on stale cards; every tap answers "Connection is recovering", the
 * player's own seat shows as disconnected, and their turns are skipped until the
 * seat forfeits for inactivity.
 *
 * The mechanism is an ORDERING one, and on mobile it is the NORMAL order:
 *
 *   t+0s   the OS freezes the socket when the app backgrounds
 *   t+1s   the app is foregrounded, reconnects, and join_room re-binds the seat
 *          to the NEW socket
 *   t+40s  socket.io finally gives up on the ABANDONED socket and delivers its
 *          `disconnect`
 *
 * That last event used to be processed as the player's disconnect: the old
 * socketId still resolved to the live playerId (joinRoom only ADDED the new
 * mapping, it never evicted the old one), so handleDisconnect ran
 * player.disconnect() and FailureManager._enterGracePeriod, which nulls
 * player.socketId. From that moment _sendInitialGameState skips the seat
 * ("Socket not found for player…") and _onTurnTimerExpired force-advances it as
 * disconnected. The player is detached from their own seat by their own return.
 *
 * Three independent guards now hold the invariant — a disconnect only counts if
 * it comes from the socket the seat is CURRENTLY on:
 *   GameService._rebindSeatSocket   (evicts the superseded mapping)
 *   SocketHandlers.handleDisconnect (ignores a stale socket outright)
 *   FailureManager._enterGracePeriod (refuses to grace a re-bound seat)
 */
/* eslint-env mocha */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const FailureManager = require('../../src/managers/FailureManager');
const GameService = require('../../src/services/GameService');
const { GameRoomStatus } = require('../../src/constants');

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

/** A dealt 2-seat room driven through the real handlers. */
function liveTable() {
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

  const room = service.createRoom('recon', 2);
  service.joinRoom('recon', 'p1', 'P1', 'sock-a');
  service.joinRoom('recon', 'p2', 'P2', 'sock-b');
  room.startGame();
  room.dealCards();
  room.currentTurn = 0;
  handlers._stopTurnTimer(room);
  registry.set('sock-a', fakeSocket('sock-a', emitted));
  registry.set('sock-b', fakeSocket('sock-b', emitted));

  return { service, room, handlers, failureManager, redis, emitted, registry };
}

/** Rejoin p1 on a brand-new socket, the way the client does after a drop. */
async function rejoinOnNewSocket(ctx, newId = 'sock-a2') {
  const socket = fakeSocket(newId, ctx.emitted);
  ctx.registry.set(newId, socket);
  await ctx.handlers.handleJoinRoom(socket, {
    roomId: 'recon',
    playerId: 'p1',
    playerName: 'P1',
  });
  return socket;
}

describe('#a stale socket must not detach a live seat', () => {
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

  it('the rejoin evicts the superseded socket mapping', async () => {
    const ctx = track(liveTable());
    await rejoinOnNewSocket(ctx);

    expect(ctx.room.getPlayer('p1').socketId).to.equal('sock-a2');
    expect(
      ctx.service.getPlayerIdBySocket('sock-a'),
      'the corpse no longer resolves to a live player'
    ).to.equal(undefined);
    expect(ctx.service.getPlayerIdBySocket('sock-a2')).to.equal('p1');
  });

  it('the OLD socket disconnecting after the rejoin leaves the seat alone', async () => {
    const ctx = track(liveTable());
    await rejoinOnNewSocket(ctx);

    // The abandoned socket finally times out, tens of seconds late.
    await ctx.handlers.handleDisconnect(ctx.registry.get('sock-a'));

    const p1 = ctx.room.getPlayer('p1');
    expect(p1.socketId, 'still bound to the live socket').to.equal('sock-a2');
    expect(p1.isConnected, 'and still connected').to.equal(true);
    expect(p1.status).to.equal('connected');
    expect(ctx.room.status).to.equal(GameRoomStatus.IN_PROGRESS);
  });

  it('and the seat still receives state afterwards', async () => {
    const ctx = track(liveTable());
    await rejoinOnNewSocket(ctx);
    await ctx.handlers.handleDisconnect(ctx.registry.get('sock-a'));
    ctx.emitted.length = 0;

    ctx.handlers._sendInitialGameState(ctx.room);

    const toP1 = ctx.emitted.filter(
      (e) => e.to === 'sock-a2' && e.event === 'game_state_update'
    );
    expect(toP1.length, 'the reconnected seat is not skipped').to.be.greaterThan(0);
    expect(toP1[0].payload.yourHand.length).to.be.greaterThan(0);
  });

  it('a disconnect from the seat\'s CURRENT socket is still a real disconnect', async () => {
    const ctx = track(liveTable());
    await rejoinOnNewSocket(ctx);

    await ctx.handlers.handleDisconnect(ctx.registry.get('sock-a2'));

    expect(
      ctx.room.getPlayer('p1').isConnected,
      'the guard must not swallow a genuine drop'
    ).to.equal(false);
  });

  it('grace refuses to detach a seat that has already moved on', async () => {
    const ctx = track(liveTable());
    await rejoinOnNewSocket(ctx);

    // The second guard, exercised directly: FailureManager still gets handed the
    // stale socket by any path that bypasses handleDisconnect.
    await ctx.failureManager.handlePlayerDisconnection({ id: 'sock-a' }, 'p1', 'recon');

    const p1 = ctx.room.getPlayer('p1');
    expect(p1.socketId, 'socketId survives').to.equal('sock-a2');
    expect(p1.status).to.equal('connected');
    expect(
      await ctx.redis.get('grace:p1:recon'),
      'and no grace record is written'
    ).to.equal(null);
  });
});
