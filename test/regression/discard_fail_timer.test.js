/**
 * A rejected discard must NOT freeze the game: it is still the player's turn, so
 * the timer (stopped before validation) has to be restarted. Previously the
 * failure branch only logged + emitted an error, leaving no running timer → the
 * game got stuck (reported with "You cannot immediately discard a card you just
 * drew").
 */

const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');

function fakeIo(socketRegistry) {
  return {
    to: () => ({ emit: () => {} }),
    sockets: { sockets: socketRegistry },
  };
}
function fakeSocket(id) {
  return { id, emit: () => {}, join: () => {}, leave: () => {}, to: () => ({ emit: () => {} }) };
}

describe('#discard-fail does not freeze the timer', () => {
  it('restarts the turn timer when a discard is rejected (card not in hand)', () => {
    const service = new GameService();
    const room = service.createRoom('disc', 2);
    service.joinRoom('disc', 'p1', 'P1', 's1');
    service.joinRoom('disc', 'p2', 'P2', 's2');
    room.startGame();
    room.dealCards();
    room.currentTurn = 0;
    room.hasDrawnCard = true;
    room.meldedThisTurn = false;

    // The taken/drawn card is now discardable (relaxed rule), so trigger the
    // rejection with a card the player does NOT hold (cardNotInHand) — any
    // rejected discard must restart the timer without changing the turn.
    room.playerHands.set('p1', [{ suit: 'hearts', rank: '5' }, { suit: 'clubs', rank: '8' }]);

    const registry = new Map();
    registry.set('s1', fakeSocket('s1'));
    registry.set('s2', fakeSocket('s2'));
    const handlers = new SocketHandlers(fakeIo(registry), service);

    // Make sure no timer is running going in.
    handlers._stopTurnTimer(room);
    expect(room.turnTimerTickHandle).to.equal(null);

    handlers.handleDiscardCard(fakeSocket('s1'), { card: { suit: 'diamonds', rank: 'K' } });

    // Turn did NOT change (still player 0) and a timer is running again.
    expect(room.currentTurn).to.equal(0);
    expect(room.turnTimerTickHandle).to.not.equal(null);

    // Clean up the interval so mocha can exit.
    service.deleteRoom('disc');
    expect(room.turnTimerTickHandle).to.equal(null);
  });
});
