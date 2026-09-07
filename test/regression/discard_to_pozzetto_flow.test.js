/* eslint-env mocha */

const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const GameValidator = require('../../src/validators/GameValidator');
const { GameRoom, PlayerSession } = require('../../src/models');
const { GameRoomStatus } = require('../../src/constants');

const card = (suit, rank) => ({ suit, rank });

function makeRoom({ maxPlayers = 2, ruleset = 'classic', professionalWellMode = 'indirect' } = {}) {
  const room = new GameRoom({ roomId: 'discard-pot', maxPlayers });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.ruleset = ruleset;
  room.professionalWellMode = professionalWellMode;
  room.currentTurn = 0;
  room.hasDrawnCard = true;
  room.deadPiles = [[card('clubs', '3'), card('clubs', '4')]];
  room.discardPile = [];

  for (let i = 0; i < maxPlayers; i += 1) {
    const playerId = `p${i + 1}`;
    room.addPlayer(new PlayerSession({
      playerId,
      playerName: `P${i + 1}`,
      playerIndex: i,
      socketId: `s${i + 1}`,
    }));
    room.playerHands.set(playerId, []);
    room.playerMelds.set(playerId, []);
    room.playerHasTakenPozzetto.set(playerId, false);
    room.playerDeadPileCount.set(playerId, 0);
    room.meldDirtyFlags.set(playerId, new Set());
  }

  return room;
}

describe('discard-to-pozzetto flow', () => {
  it('Classic allows discarding the last first-hand card to take the POT without closing', () => {
    const room = makeRoom();
    const lastCard = card('spades', '5');
    room.playerHands.set('p1', [lastCard]);

    const validation = GameValidator.validateDiscard(room, 'p1', lastCard);
    expect(validation.isValid).to.equal(true);
    expect(validation.willTakePozzetto).to.equal(true);

    const result = ActionHandlers.handleDiscard(room, 'p1', lastCard);

    expect(result.success).to.equal(true);
    expect(result.roundEnded).to.equal(undefined);
    expect(result.broadcast.pozzettoTaken).to.equal(2);
    expect(room.playerHands.get('p1')).to.have.length(2);
    expect(room.discardPile).to.have.length(1);
    expect(room.playerDeadPileCount.get('teamA')).to.equal(1);
    expect(room.playerDeadPileCount.get('p1')).to.equal(1);
    // An indirect take is the discard that ENDED the turn — the refilled hand is
    // played when the table comes back around, not immediately.
    expect(result.turnKept).to.equal(undefined);
    expect(room.currentTurn).to.not.equal(0);
    expect(room.hasDrawnCard).to.equal(false);
  });

  it('Professional indirect allows first well by discard when the side has a Brazilia', () => {
    const room = makeRoom({ maxPlayers: 4, ruleset: 'professional', professionalWellMode: 'indirect' });
    const lastCard = card('spades', '5');
    room.playerHands.set('p1', [lastCard]);
    room.playerMelds.set('p3', [Array.from({ length: 7 }, () => card('hearts', '3'))]);

    const result = ActionHandlers.handleDiscard(room, 'p1', lastCard);

    expect(result.success).to.equal(true);
    expect(result.roundEnded).to.equal(undefined);
    expect(result.broadcast.pozzettoTaken).to.equal(2);
    expect(room.playerHands.get('p1')).to.have.length(2);
    expect(room.playerPozzettoTakeMode.get('teamA')).to.equal('indirect');
    // An indirect take is the discard that ENDED the turn.
    expect(result.turnKept).to.equal(undefined);
    expect(room.currentTurn).to.not.equal(0);
  });

  it('Professional direct rejects discarding the last card to obtain a well', () => {
    const room = makeRoom({ ruleset: 'professional', professionalWellMode: 'direct' });
    const lastCard = card('spades', '5');
    room.playerHands.set('p1', [lastCard]);
    room.playerMelds.set('p1', [Array.from({ length: 7 }, () => card('hearts', '3'))]);

    const validation = GameValidator.validateDiscard(room, 'p1', lastCard);

    expect(validation.isValid).to.equal(false);
    expect(validation.reason).to.equal('invalidClose');
  });
});
