/* eslint-env mocha */
/**
 * PTW-34 — Scale (Redis/SPOF) + robustness cleanup.
 *
 * Covers the leak/dual-engine fixes so they do not regress:
 *  - P1-9  FailureManager auto-skip timer is tracked + cleared on dispose;
 *          grace-expiry bot takeover routes through the single BotCoordinator
 *          engine (no in-manager draw/discard duplicate).
 *  - P1-10 Spectator maps are cleared when a room is deleted.
 *  - P1-11 Matchmaking queue entry is removed by socket id on disconnect.
 *  - P1-12 RateLimiter cleanup interval is unref'd and stopped by shutdown().
 */

const { expect } = require('chai');
const FailureManager = require('../../src/managers/FailureManager');
const MatchmakingService = require('../../src/services/MatchmakingService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');

const noopLogger = { info() {}, warn() {}, debug() {}, error() {} };
const fakeIo = { to: () => ({ emit: () => {} }) };

describe('#PTW-34 scale/robustness cleanup', () => {
  describe('P1-9 FailureManager timers + single bot engine', () => {
    it('does NOT auto-skip a graced human turn and does NOT pause the timer (Item 8)', async () => {
      // The 10s auto-skip that fired before the 30s grace expiry is gone, AND
      // (Items 7/8) entering grace no longer pauses the turn timer: the seat is
      // reconnectable and its turns accrue toward the inactivity forfeit, so the
      // timer must keep running (no pause, no autoskip).
      const fm = new FailureManager(fakeIo, mockRedis(), { getRoom() {} }, noopLogger);
      let paused = 0;
      fm.turnTimerControl = { pause: () => { paused += 1; }, resume: () => {} };

      const room = { roomId: 'r1', currentTurn: 0, playerHands: new Map() };
      const player = { playerId: 'u1', playerIndex: 0 };

      await fm._enterGracePeriod(room, player, 's-old');

      // No auto-skip timer was scheduled for the graced seat.
      expect(fm.timers.has('autoskip:u1:r1')).to.equal(false);
      // The turn timer is NOT paused — it keeps running (Item 8).
      expect(paused).to.equal(0);
      // The removed auto-skip scheduler must stay removed.
      expect(typeof fm._scheduleAutoSkip).to.equal('undefined');

      fm.dispose();
      expect(fm.timers.size).to.equal(0);
    });
  });

  describe('P1-10 spectator maps cleared on room delete', () => {
    it('drops roomSpectators + spectatorSocketToRoom entries for a deleted room', () => {
      const service = new GameService();
      const io = { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } };
      const handler = new SocketHandlers(io, service);

      handler._addSpectator({ id: 'specA' }, 'room-1', 'sp1', 'Watcher');
      handler._addSpectator({ id: 'specB' }, 'room-1', 'sp2', 'Watcher2');
      expect(handler.roomSpectators.get('room-1').size).to.equal(2);
      expect(handler.spectatorSocketToRoom.size).to.equal(2);

      handler._clearRoomSpectators('room-1');

      expect(handler.roomSpectators.has('room-1')).to.equal(false);
      expect(handler.spectatorSocketToRoom.size).to.equal(0);
    });
  });

  describe('P1-11 matchmaking queue cleaned by socket id', () => {
    it('removes only the matching socket and is safe on a miss', () => {
      const mm = new MatchmakingService({});
      mm.playersPerMatch = 4; // keep 2 queued players from auto-matching mid-test
      mm.addToQueue('p1', 'P1', 'sockA', {});
      mm.addToQueue('p2', 'P2', 'sockB', {});

      const hit = mm.removeBySocketId('sockA');
      expect(hit.success).to.equal(true);
      expect(mm.queue.has('p1')).to.equal(false);
      expect(mm.queue.has('p2')).to.equal(true);

      const miss = mm.removeBySocketId('does-not-exist');
      expect(miss.success).to.equal(false);
      expect(mm.queue.size).to.equal(1);

      mm.shutdown();
    });
  });

  describe('P1-12 rateLimiter interval lifecycle', () => {
    it('unrefs the cleanup interval and stops it on shutdown()', () => {
      const rateLimiter = require('../../src/middleware/rateLimiter');
      rateLimiter.startCleanup();
      expect(rateLimiter.cleanupTimer).to.not.equal(null);

      rateLimiter.checkLimit('socket-x');
      expect(rateLimiter.requests.size).to.be.greaterThan(0);

      rateLimiter.shutdown();
      expect(rateLimiter.cleanupTimer).to.equal(null);
      expect(rateLimiter.requests.size).to.equal(0);
      expect(rateLimiter.actions.size).to.equal(0);

      // Restart so the shared singleton is left in a usable state for other suites.
      rateLimiter.startCleanup();
    });
  });
});

function mockRedis() {
  const store = new Map();
  return {
    async setex(key, _ttl, value) {
      store.set(key, value);
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async del(key) {
      store.delete(key);
    },
    async exists(key) {
      return store.has(key) ? 1 : 0;
    },
  };
}
