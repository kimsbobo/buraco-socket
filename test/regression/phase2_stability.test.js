/**
 * Phase 2 — stability regression tests.
 *
 *   - S-C8: deleting a room cancels its turn-timer interval so it cannot keep
 *           firing (memory/CPU leak) after the room is gone.
 */

const { expect } = require('chai');
const GameService = require('../../src/services/GameService');

describe('Phase 2 stability', () => {
  describe('S-C8 — room deletion cancels turn timers', () => {
    it('clears turnTimerTickHandle/turnTimerHandle on delete and stops the interval', () => {
      const service = new GameService();
      const room = service.createRoom('leak-room', 2);
      service.joinRoom(room.roomId, 'p1', 'P1', 's1');

      // Simulate a running turn timer (as SocketHandlers._startTurnTimer would set).
      let ticks = 0;
      room.turnTimerTickHandle = setInterval(() => { ticks++; }, 5);
      room.turnTimerHandle = setTimeout(() => {}, 100000);

      service.deleteRoom(room.roomId);

      expect(room.turnTimerTickHandle).to.equal(null);
      expect(room.turnTimerHandle).to.equal(null);

      // Confirm the interval really stopped: capture count and ensure no growth.
      const snapshot = ticks;
      return new Promise((resolve) => {
        setTimeout(() => {
          expect(ticks).to.equal(snapshot);
          resolve();
        }, 40);
      });
    });
  });
});
