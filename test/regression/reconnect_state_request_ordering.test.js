/**
 * CONNECTION STABILITY — "koneksi sensitif banget, kadang suka reconnecting".
 *
 * Two independent defects, both visible in this production log excerpt:
 *
 *   16:53:29.324 Player 7 requesting to join room BRC-Z573M
 *   16:53:29.326 [GET_GAME_STATE] Player 7 requesting state for game BRC-Z573M
 *   16:53:29.327 [GET_GAME_STATE] Player 7 requesting state for game BRC-Z573M
 *   16:53:29.330 [FailureManager] Reconnection successful: 7 (6ms)
 *
 * 1. THE STATE REQUEST OVERTOOK THE JOIN. The client emits `join_room` and then
 *    `get_game_state` synchronously, in that order, precisely so the seat is
 *    re-bound before the snapshot is asked for. `handleJoinRoom` is async and
 *    awaits Redis, and Socket.IO does not wait for one handler before delivering
 *    the next packet — so both state requests ran DURING the join's awaits, at
 *    .326/.327, while the seat was still detached (grace nulls
 *    `player.socketId`). `_assertSocketCanViewPlayerState` refuses an
 *    unauthenticated socket in that state, so the returning player got
 *    "Unauthorized player state" and NO snapshot — which is also silence for the
 *    client's resume probe, whose answer to silence was to force-close its own
 *    socket.
 *
 * 2. A REJOIN FROM THE SAME SOCKET WAS TREATED AS A RECONNECT. The client
 *    re-emits `join_room` on every app resume (a notification-shade pull counts),
 *    because `socket.connected` cannot be trusted across a half-open socket.
 *    `GameService.joinRoom` reports `reconnected: true` for any rejoin by a
 *    seated player, so every one of those announced PLAYER_RECONNECTED to the
 *    whole table and paid for a Redis grace release — for a player who never
 *    went anywhere.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const FailureManager = require('../../src/managers/FailureManager');
const GameService = require('../../src/services/GameService');
const { SocketEvents } = require('../../src/constants');

const noopLogger = { info() {}, warn() {}, debug() {}, error() {} };

/** Redis with a real (microtask) delay, so the join genuinely yields. */
function slowRedis() {
  const store = new Map();
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    store,
    async setex(key, _ttl, val) { await tick(); store.set(key, val); },
    async set(key, val) { await tick(); store.set(key, val); },
    async get(key) { await tick(); return store.has(key) ? store.get(key) : null; },
    async del(key) { await tick(); store.delete(key); },
    async exists(key) { await tick(); return store.has(key) ? 1 : 0; },
    async keys() { await tick(); return Array.from(store.keys()); },
  };
}

function fakeSocket(id, emitted) {
  return {
    id,
    handshake: { headers: {} },
    data: {},
    join: () => {},
    leave: () => {},
    emit: (event, payload) => emitted.push({ to: id, event, payload }),
    to: (roomId) => ({ emit: (event, payload) => emitted.push({ roomId, event, payload }) }),
  };
}

function liveTable() {
  const emitted = [];
  const registry = new Map();
  const service = new GameService();
  const io = {
    to: (roomId) => ({ emit: (event, payload) => emitted.push({ roomId, event, payload }) }),
    sockets: { sockets: registry },
  };
  const redis = slowRedis();
  const failureManager = new FailureManager(io, redis, service, noopLogger);
  const handlers = new SocketHandlers(io, service, null, failureManager);

  const room = service.createRoom('ORDER1', 2);
  service.joinRoom('ORDER1', 'p1', 'P1', 'sock-a');
  service.joinRoom('ORDER1', 'p2', 'P2', 'sock-b');
  room.startGame();
  room.dealCards();
  room.currentTurn = 0;
  handlers._stopTurnTimer(room);
  registry.set('sock-a', fakeSocket('sock-a', emitted));
  registry.set('sock-b', fakeSocket('sock-b', emitted));

  return { service, room, handlers, failureManager, redis, emitted, registry };
}

/** Drive the two events the way Socket.IO does: back to back, join NOT awaited. */
function reconnectBurst(ctx, socketId = 'sock-a2') {
  const socket = fakeSocket(socketId, ctx.emitted);
  ctx.registry.set(socketId, socket);

  // Exactly what registerEventHandlers does for join_room.
  const join = ctx.handlers._trackPendingJoin(
    socket.id,
    ctx.handlers.handleJoinRoom(socket, {
      roomId: 'ORDER1',
      playerId: 'p1',
      playerName: 'P1',
      previousSocketId: 'sock-a',
      reconnect: true,
    })
  );

  // ...and the state request Socket.IO delivers while that is still awaiting.
  ctx.handlers.handleGetGameState(socket, { gameId: 'ORDER1', playerId: 'p1' });

  return { socket, join };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('#reconnect: get_game_state must not overtake join_room', () => {
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

  it('the seat is DETACHED while the join awaits — this is the hazard', async () => {
    const ctx = track(liveTable());
    // The drop entered grace, which nulls player.socketId.
    await ctx.handlers.handleDisconnect(ctx.registry.get('sock-a'), 'transport close');
    expect(
      ctx.room.getPlayer('p1').socketId,
      'grace detaches the seat, so an unauthenticated socket cannot be authorised for it'
    ).to.equal(null);
  });

  it('answers the deferred state request with a real snapshot, not an error', async () => {
    const ctx = track(liveTable());
    await ctx.handlers.handleDisconnect(ctx.registry.get('sock-a'), 'transport close');
    ctx.emitted.length = 0;

    const { socket, join } = reconnectBurst(ctx);
    await join;
    await settle();

    const mine = ctx.emitted.filter((e) => e.to === socket.id);
    const unauthorized = mine.filter(
      (e) => e.event === SocketEvents.ERROR && /Unauthorized player state/.test(e.payload?.error || '')
    );
    expect(unauthorized, 'the returning player must not be refused their own board').to.have.length(0);

    const states = mine.filter((e) => e.event === SocketEvents.GAME_STATE_UPDATE);
    expect(states.length, 'the resync is answered').to.be.greaterThan(0);
    expect(states[states.length - 1].payload.yourPlayerIndex).to.equal(0);
    expect(states[states.length - 1].payload.yourHand.length).to.be.greaterThan(0);
  });

  it('a state request with NO join in flight is still answered synchronously', () => {
    const ctx = track(liveTable());
    ctx.emitted.length = 0;

    ctx.handlers.handleGetGameState(ctx.registry.get('sock-a'), {
      gameId: 'ORDER1',
      playerId: 'p1',
    });

    // No await: the non-deferred path must not become async for existing callers.
    expect(
      ctx.emitted.some((e) => e.event === SocketEvents.GAME_STATE_UPDATE),
      'the fast path stays synchronous'
    ).to.equal(true);
  });

  it('the pending-join record is dropped once the join settles', async () => {
    const ctx = track(liveTable());
    const { socket, join } = reconnectBurst(ctx);
    await join;
    await settle();
    expect(ctx.handlers._pendingJoins.has(socket.id)).to.equal(false);
  });
});

describe('#resume: a rejoin on the SAME socket is a refresh, not a reconnect', () => {
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

  it('announces nothing to the table when the seat never moved', async () => {
    const ctx = track(liveTable());
    ctx.emitted.length = 0;

    // What resyncOnResume sends on a perfectly healthy socket.
    await ctx.handlers.handleJoinRoom(ctx.registry.get('sock-a'), {
      roomId: 'ORDER1',
      playerId: 'p1',
      playerName: 'P1',
      reconnect: true,
    });

    expect(
      ctx.emitted.filter((e) => e.event === SocketEvents.PLAYER_RECONNECTED),
      'the other seats must not be told a player reconnected when none did'
    ).to.have.length(0);
  });

  it('still resyncs the board — the client asked to be re-synced', async () => {
    const ctx = track(liveTable());
    ctx.emitted.length = 0;

    await ctx.handlers.handleJoinRoom(ctx.registry.get('sock-a'), {
      roomId: 'ORDER1',
      playerId: 'p1',
      playerName: 'P1',
      reconnect: true,
    });

    const mine = ctx.emitted.filter(
      (e) => e.to === 'sock-a' && e.event === SocketEvents.GAME_STATE_UPDATE
    );
    expect(mine.length, 'suppressing the ceremony must not suppress the state').to.be.greaterThan(0);
  });

  it('a rejoin on a DIFFERENT socket is still a real reconnect', async () => {
    const ctx = track(liveTable());
    await ctx.handlers.handleDisconnect(ctx.registry.get('sock-a'), 'transport close');
    ctx.emitted.length = 0;

    const socket = fakeSocket('sock-a3', ctx.emitted);
    ctx.registry.set('sock-a3', socket);
    await ctx.handlers.handleJoinRoom(socket, {
      roomId: 'ORDER1',
      playerId: 'p1',
      playerName: 'P1',
      reconnect: true,
    });

    expect(
      ctx.emitted.filter((e) => e.event === SocketEvents.PLAYER_RECONNECTED).length,
      'a genuine return after a drop must still be announced'
    ).to.be.greaterThan(0);
  });
});

describe('#the deferred wait is bounded', () => {
  it('answers even if the join never settles', async function () {
    this.timeout(6000);
    const emitted = [];
    const registry = new Map();
    const service = new GameService();
    const io = {
      to: (roomId) => ({ emit: (event, payload) => emitted.push({ roomId, event, payload }) }),
      sockets: { sockets: registry },
    };
    const handlers = new SocketHandlers(io, service);
    const room = service.createRoom('HANG1', 2);
    service.joinRoom('HANG1', 'p1', 'P1', 'sock-a');
    service.joinRoom('HANG1', 'p2', 'P2', 'sock-b');
    room.startGame();
    room.dealCards();
    handlers._stopTurnTimer(room);
    const socket = fakeSocket('sock-a', emitted);
    registry.set('sock-a', socket);

    // `_rebuildRoomFromBackend` uses Node's fetch, which has NO default timeout:
    // a stalled backend is a join that never settles.
    handlers._trackPendingJoin('sock-a', new Promise(() => {}));
    handlers.handleGetGameState(socket, { gameId: 'HANG1', playerId: 'p1' });

    expect(emitted.some((e) => e.event === SocketEvents.GAME_STATE_UPDATE)).to.equal(false);

    await new Promise((resolve) => setTimeout(resolve, SocketHandlers.JOIN_WAIT_CAP_MS + 200));

    expect(
      emitted.some((e) => e.event === SocketEvents.GAME_STATE_UPDATE),
      'a hung join must not swallow the answer forever'
    ).to.equal(true);

    service.shutdown();
  });
});
