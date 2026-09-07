/**
 * FailureManager._skipPlayerTurn (disconnect grace auto-skip) used to advance the
 * turn with a hardcoded path and only reset phase/hasDrawnCard. That (a) could
 * diverge from the fixed clockwise turn contract and (b) left stale per-turn
 * restriction state on the next player. It now
 * delegates to the canonical room.nextTurn(), so a disconnect-skip is consistent
 * with the main turn engine.
 */
/* eslint-env mocha */

const { expect } = require('chai');
const FailureManager = require('../../src/managers/FailureManager');
const GameService = require('../../src/services/GameService');

const noopLogger = { info() {}, warn() {}, debug() {}, error() {} };
const fakeIo = { to: () => ({ emit: () => {} }) };

function fm() {
  return new FailureManager(fakeIo, {}, new GameService(), noopLogger);
}

function room4() {
  const service = new GameService();
  const room = service.createRoom('skip', 4);
  ['p1', 'p2', 'p3', 'p4'].forEach((id, i) => service.joinRoom('skip', id, id.toUpperCase(), `s${i}`));
  room.startGame();
  room.dealCards();
  return { service, room };
}

describe('#FailureManager skip consistency', () => {
  it('ignores legacy counter-clockwise direction and advances clockwise', () => {
    const manager = fm();
    const { service, room } = room4();
    room.currentTurn = 0;
    room.turnDirection = -1;
    room.phase = 'draw';
    room.hasDrawnCard = true; // already drew → no auto-draw, pure advance

    manager._skipPlayerTurn(room, room.getPlayer('p1'));

    // Historical snapshots may contain -1; the live contract still advances +1.
    expect(room.currentTurn).to.equal(1);
    service.deleteRoom('skip');
  });

  it('advances clockwise when turnDirection = +1', () => {
    const manager = fm();
    const { service, room } = room4();
    room.currentTurn = 1;
    room.turnDirection = 1;
    room.hasDrawnCard = true;

    manager._skipPlayerTurn(room, room.getPlayer('p2'));

    expect(room.currentTurn).to.equal(2);
    service.deleteRoom('skip');
  });

  it('clears per-turn tracking state for the next player', () => {
    const manager = fm();
    const { service, room } = room4();
    room.currentTurn = 0;
    room.turnDirection = 1;
    room.hasDrawnCard = true;
    room.mustMeldCard = { suit: 'hearts', rank: 'K' };
    room.meldedThisTurn = true;
    room.drawnCardThisTurnRestriction = new Set(['x']);

    manager._skipPlayerTurn(room, room.getPlayer('p1'));

    expect(room.hasDrawnCard).to.equal(false);
    expect(room.phase).to.equal('draw');
    expect(room.mustMeldCard).to.equal(null);
    expect(room.meldedThisTurn).to.equal(false);
    expect(room.drawnCardThisTurnRestriction.size).to.equal(0);
    service.deleteRoom('skip');
  });

  it('auto-draws for a player who had not drawn before skipping', () => {
    const manager = fm();
    const { service, room } = room4();
    room.currentTurn = 0;
    room.turnDirection = 1;
    room.phase = 'draw';
    room.hasDrawnCard = false;
    const before = (room.playerHands.get('p1') || []).length;

    manager._skipPlayerTurn(room, room.getPlayer('p1'));

    expect((room.playerHands.get('p1') || []).length).to.equal(before + 1);
    service.deleteRoom('skip');
  });
});
