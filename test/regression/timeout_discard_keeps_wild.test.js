/* eslint-env mocha */

// Timeout auto-discard must NOT throw away a wildcard (2 / joker) when a natural
// card can be discarded instead — wilds are the most valuable cards and a
// timeout should cost the player as little as possible. A wild is only discarded
// when it is the sole legal option, and a lone un-closeable 2 is never force-
// discarded illegally (the turn is safely skipped instead).

const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');

function fakeIo(socketRegistry) {
  return { to: () => ({ emit: () => {} }), sockets: { sockets: socketRegistry } };
}
function fakeSocket(id) {
  return { id, emit: () => {}, join: () => {}, leave: () => {}, to: () => ({ emit: () => {} }) };
}
function makeHandlers(service) {
  const registry = new Map();
  registry.set('s1', fakeSocket('s1'));
  registry.set('s2', fakeSocket('s2'));
  return new SocketHandlers(fakeIo(registry), service);
}
const top = (room) => room.discardPile[room.discardPile.length - 1];

describe('#timeout auto-discard keeps wildcards', () => {
  it('discards the NATURAL card and keeps the 2 / joker', () => {
    const service = new GameService();
    const room = service.createRoom('t-wild', 2);
    service.joinRoom('t-wild', 'p1', 'P1', 's1');
    service.joinRoom('t-wild', 'p2', 'P2', 's2');
    room.startGame();
    room.dealCards();
    room.ruleset = 'classic';
    room.currentTurn = 0;
    room.hasDrawnCard = true;
    room.meldedThisTurn = false;
    room.drawnCardThisTurnRestriction = new Set();
    room.playerHands.set('p1', [
      { suit: 'hearts', rank: '2' }, { suit: 'clubs', rank: '5' }, { suit: 'joker', rank: 'joker' },
    ]);

    const handlers = makeHandlers(service);
    handlers._onTurnTimerExpired(room);

    // The natural 5♣ went to the pile; both wilds stayed in hand.
    expect(top(room).rank).to.equal('5');
    const hand = room.playerHands.get('p1');
    expect(hand.some((c) => c.rank === '2')).to.equal(true);
    expect(hand.some((c) => c.rank === 'joker')).to.equal(true);
    expect(room.currentTurn).to.equal(1); // turn advanced normally

    service.deleteRoom('t-wild');
  });

  it('falls back to discarding a wild ONLY when no natural card is legally discardable', () => {
    const service = new GameService();
    const room = service.createRoom('t-onlywild', 2);
    service.joinRoom('t-onlywild', 'p1', 'P1', 's1');
    service.joinRoom('t-onlywild', 'p2', 'P2', 's2');
    room.startGame();
    room.dealCards();
    room.ruleset = 'classic';
    room.currentTurn = 0;
    room.hasDrawnCard = true;
    room.meldedThisTurn = false;
    room.drawnCardThisTurnRestriction = new Set();
    // Two wilds, size 2 → discarding one is a legal NON-closing discard; a wild
    // must be thrown because there is no natural, and the turn must not freeze.
    room.playerHands.set('p1', [{ suit: 'hearts', rank: '2' }, { suit: 'diamonds', rank: '2' }]);

    const handlers = makeHandlers(service);
    handlers._onTurnTimerExpired(room);

    expect(top(room).rank).to.equal('2');
    expect(room.currentTurn).to.equal(1);

    service.deleteRoom('t-onlywild');
  });

  it('never force-discards a lone un-closeable 2 — safely skips the turn instead', () => {
    const service = new GameService();
    const room = service.createRoom('t-lone2', 2);
    service.joinRoom('t-lone2', 'p1', 'P1', 's1');
    service.joinRoom('t-lone2', 'p2', 'P2', 's2');
    room.startGame();
    room.dealCards();
    room.ruleset = 'classic';
    room.currentTurn = 0;
    room.hasDrawnCard = true; // already drew, so no auto-draw refill this expiry
    room.meldedThisTurn = false;
    room.drawnCardThisTurnRestriction = new Set();
    // No well on the table (already gone), so the lone 2 is genuinely
    // un-closeable — discarding it would be an illegal classic close, NOT an
    // indirect well-take. This is the true "stuck lone 2" the user described.
    room.deadPiles = [];
    room.pozzetto = null;
    room.playerHands.set('p1', [{ suit: 'hearts', rank: '2' }]);

    const handlers = makeHandlers(service);
    const pileBefore = room.discardPile.length;
    handlers._onTurnTimerExpired(room);

    // The lone wild was NOT discarded (illegal close) and the turn was skipped so
    // the game keeps moving instead of freezing.
    expect(room.discardPile.length).to.equal(pileBefore);
    expect(room.playerHands.get('p1').some((c) => c.rank === '2')).to.equal(true);
    expect(room.currentTurn).to.equal(1);

    service.deleteRoom('t-lone2');
  });
});
