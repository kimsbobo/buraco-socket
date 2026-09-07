/**
 * PTW-81 observability tests: metrics registry, ghost-occupancy drift monitor,
 * stuck-animation watchdog ingest, and the socket-side game-result double-fire
 * counter.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const metrics = require('../src/observability/metrics');
const OccupancyMonitor = require('../src/observability/OccupancyMonitor');

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Minimal active-room stub: getPlayers() + roomId, like a real GameRoom. */
function makeRoom(roomId, players) {
  return { roomId, getPlayers: () => players };
}

/** Fake Socket.IO server exposing only what the monitor reads. */
function makeIo(roomSizes = {}, totalSockets = 0) {
  const rooms = new Map();
  for (const [id, size] of Object.entries(roomSizes)) {
    rooms.set(id, { size });
  }
  return { sockets: { adapter: { rooms }, sockets: { size: totalSockets } } };
}

// ---------------------------------------------------------------------------
// Metrics registry
// ---------------------------------------------------------------------------
describe('PTW-81 metrics registry', () => {
  beforeEach(() => metrics.reset());

  it('increments counters and renders Prometheus text with HELP/TYPE', () => {
    metrics.increment('buraco_stuck_anim_watchdog_total', { reason: 'deal' });
    metrics.increment('buraco_stuck_anim_watchdog_total', { reason: 'deal' });
    metrics.increment('buraco_stuck_anim_watchdog_total', { reason: 'draw' });

    expect(metrics.get('buraco_stuck_anim_watchdog_total', { reason: 'deal' })).to.equal(2);
    expect(metrics.get('buraco_stuck_anim_watchdog_total', { reason: 'draw' })).to.equal(1);

    const text = metrics.renderProm();
    expect(text).to.include('# TYPE buraco_stuck_anim_watchdog_total counter');
    expect(text).to.include('buraco_stuck_anim_watchdog_total{reason="deal"} 2');
    expect(text).to.include('buraco_stuck_anim_watchdog_total{reason="draw"} 1');
  });

  it('setGauge overwrites and snapshot reflects current values', () => {
    metrics.setGauge('buraco_ghost_occupancy_drift_rooms', 3);
    metrics.setGauge('buraco_ghost_occupancy_drift_rooms', 1);
    expect(metrics.get('buraco_ghost_occupancy_drift_rooms')).to.equal(1);
    expect(metrics.snapshot()['buraco_ghost_occupancy_drift_rooms']).to.equal(1);
  });
});

// ---------------------------------------------------------------------------
// Ghost-occupancy drift monitor
// ---------------------------------------------------------------------------
describe('PTW-81 OccupancyMonitor', () => {
  beforeEach(() => metrics.reset());

  const human = (id) => ({ playerId: id, isBot: false });
  const bot = (id) => ({ playerId: id, isBot: true });

  it('does NOT flag a room with live sockets', () => {
    const gameService = {
      getActiveRooms: () => [makeRoom('r1', [human('a'), human('b')])],
    };
    const io = makeIo({ r1: 2 }, 2);
    const mon = new OccupancyMonitor({ io, gameService, metrics }, { graceMs: 1000 });

    const res = mon.sweep(10_000);
    expect(res.driftRooms).to.equal(0);
    expect(metrics.get('buraco_ghost_occupancy_drift_rooms')).to.equal(0);
    expect(metrics.get('buraco_active_rooms')).to.equal(1);
  });

  it('ignores a bot-only room (no seated humans)', () => {
    const gameService = { getActiveRooms: () => [makeRoom('r1', [bot('z')])] };
    const mon = new OccupancyMonitor(
      { io: makeIo({}, 0), gameService, metrics },
      { graceMs: 0 }
    );
    expect(mon.sweep(10_000).driftRooms).to.equal(0);
  });

  it('holds drift during the grace window, then counts + alerts once sustained', () => {
    const gameService = {
      getActiveRooms: () => [makeRoom('r1', [human('a'), human('b')])],
    };
    // No live sockets for r1 → drifting.
    const io = makeIo({}, 0);
    const mon = new OccupancyMonitor({ io, gameService, metrics }, { graceMs: 60_000 });

    // First sighting: within grace, not yet counted.
    let res = mon.sweep(0);
    expect(res.driftRooms).to.equal(0);
    expect(metrics.get('buraco_ghost_occupancy_drift_total')).to.equal(0);

    // Still within grace.
    res = mon.sweep(30_000);
    expect(res.driftRooms).to.equal(0);

    // Past grace → counted, and the cumulative counter increments exactly once.
    res = mon.sweep(70_000);
    expect(res.driftRooms).to.equal(1);
    expect(metrics.get('buraco_ghost_occupancy_drift_total')).to.equal(1);

    // Subsequent sweeps keep the gauge but don't double-count the total.
    res = mon.sweep(100_000);
    expect(res.driftRooms).to.equal(1);
    expect(metrics.get('buraco_ghost_occupancy_drift_total')).to.equal(1);
  });

  it('clears drift bookkeeping when sockets reconnect within grace', () => {
    let live = 0;
    const gameService = {
      getActiveRooms: () => [makeRoom('r1', [human('a')])],
    };
    const io = {
      sockets: {
        adapter: { rooms: { get: () => (live > 0 ? { size: live } : undefined) } },
        sockets: { size: live },
      },
    };
    const mon = new OccupancyMonitor({ io, gameService, metrics }, { graceMs: 60_000 });

    mon.sweep(0); // drifting starts
    live = 1; // client reconnects before grace elapses
    const res = mon.sweep(30_000);
    expect(res.driftRooms).to.equal(0);
    // And drift must not later fire for this resolved room.
    live = 0;
    const res2 = mon.sweep(40_000); // fresh drift window starts at 40k
    expect(res2.driftRooms).to.equal(0);
  });
});

// ---------------------------------------------------------------------------
// SocketHandlers ingest points
// ---------------------------------------------------------------------------
describe('PTW-81 SocketHandlers instrumentation', () => {
  const SocketHandlers = require('../src/handlers/SocketHandlers');
  const { GameRoom } = require('../src/models');

  beforeEach(() => metrics.reset());

  it('handleAnimWatchdog buckets unknown reasons into "other" and counts known ones', () => {
    const handlers = Object.create(SocketHandlers.prototype);
    const socket = { id: 'sock-1' };

    handlers.handleAnimWatchdog(socket, { reason: 'deal' });
    handlers.handleAnimWatchdog(socket, { reason: 'TAKE_PILE' }); // case-insensitive
    handlers.handleAnimWatchdog(socket, { reason: 'totally-made-up' });
    handlers.handleAnimWatchdog(socket, {}); // missing reason

    expect(metrics.get('buraco_stuck_anim_watchdog_total', { reason: 'deal' })).to.equal(1);
    expect(metrics.get('buraco_stuck_anim_watchdog_total', { reason: 'take_pile' })).to.equal(1);
    expect(metrics.get('buraco_stuck_anim_watchdog_total', { reason: 'other' })).to.equal(2);
  });

  it('counts a suppressed game-result double-fire when resultReported is already set', () => {
    const handlers = Object.create(SocketHandlers.prototype);
    const room = new GameRoom({ roomId: 'r1', maxPlayers: 2 });
    room.resultReported = true; // already reported

    handlers._notifyBackendGameResult(room, null);
    handlers._notifyBackendGameResult(room, null);

    expect(metrics.get('buraco_game_result_double_fire_total')).to.equal(2);
  });
});
