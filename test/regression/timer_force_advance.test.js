/* eslint-env mocha */

/**
 * #6 — the turn timer must never leave the game frozen.
 * If a timed-out player has no legal auto-discard, the server force-advances the
 * turn and restarts the timer instead of stopping the timer and hanging.
 */

const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');

function fakeIo(emitted) {
  return {
    to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }),
    sockets: { sockets: new Map() },
  };
}

describe('#6 turn timer never freezes', () => {
  afterEach(() => {
    // Nothing persistent; timers are cleared by deleteRoom/forceAdvance.
  });

  it('force-advances the turn when the timed-out player has no legal discard', () => {
    const service = new GameService();
    const room = service.createRoom('stuck', 2);
    service.joinRoom('stuck', 'p1', 'P1', 's1');
    service.joinRoom('stuck', 'p2', 'P2', 's2');
    room.startGame();
    room.dealCards();
    room.currentTurn = 0;
    room.hasDrawnCard = true; // skip auto-draw
    room.deadPiles = [];
    room.pozzetto = null;

    // p1 holds only a joker and no well/POT is available → cannot legally discard
    // (closing rule), and the
    // hand[0] fallback is rejected too, so without the safety net the turn hangs.
    room.playerHands.set('p1', [{ suit: 'joker', rank: 'joker' }]);

    const emitted = [];
    const handlers = new SocketHandlers(fakeIo(emitted), service);

    handlers._onTurnTimerExpired(room);

    // Turn advanced to player 1, and a forced turn_changed was broadcast.
    expect(room.currentTurn).to.equal(1);
    const turnChanged = emitted.find((e) => e.event === 'turn_changed');
    expect(turnChanged, 'turn_changed emitted').to.exist;
    expect(turnChanged.payload.forced).to.equal(true);
    // A new turn timer was started for the next player.
    expect(room.turnTimerTickHandle).to.not.equal(null);

    // Cleanup the interval so mocha can exit.
    service.deleteRoom('stuck');
    expect(room.turnTimerTickHandle).to.equal(null);
  });
});
