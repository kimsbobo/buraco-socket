const { expect } = require('chai');
const GameValidator = require('../src/validators/GameValidator');
const { GameRoom } = require('../src/models');
const PlayerSession = require('../src/models/PlayerSession');
const { GameRoomStatus } = require('../src/constants');

const card = (suit, rank) => ({ suit, rank });

describe('GameValidator', () => {
  it('rejects melds with cards not in hand', () => {
    const room = new GameRoom({ roomId: 'r1', maxPlayers: 2 });
    room.status = GameRoomStatus.IN_PROGRESS;
    room.currentTurn = 0;
    room.hasDrawnCard = true;

    const p1 = new PlayerSession({ playerId: 'p1', playerName: 'P1', playerIndex: 0, socketId: 's1' });
    const p2 = new PlayerSession({ playerId: 'p2', playerName: 'P2', playerIndex: 1, socketId: 's2' });
    room.addPlayer(p1);
    room.addPlayer(p2);

    room.playerHands.set('p1', [card('hearts', '3'), card('hearts', '4'), card('hearts', '5')]);

    const result = GameValidator.validateMeld(room, 'p1', [card('hearts', '3'), card('hearts', '4'), card('spades', '9')]);
    expect(result.isValid).to.equal(false);
  });

  it('rejects melds with duplicate cards', () => {
    const room = new GameRoom({ roomId: 'r1', maxPlayers: 2 });
    room.status = GameRoomStatus.IN_PROGRESS;
    room.currentTurn = 0;
    room.hasDrawnCard = true;

    const p1 = new PlayerSession({ playerId: 'p1', playerName: 'P1', playerIndex: 0, socketId: 's1' });
    room.addPlayer(p1);
    room.playerHands.set('p1', [card('hearts', '3'), card('hearts', '4'), card('hearts', '5')]);

    const result = GameValidator.validateMeld(room, 'p1', [card('hearts', '3'), card('hearts', '3'), card('hearts', '4')]);
    expect(result.isValid).to.equal(false);
  });

  it('validates add-to-meld with card ownership', () => {
    const room = new GameRoom({ roomId: 'r1', maxPlayers: 2 });
    room.status = GameRoomStatus.IN_PROGRESS;
    room.currentTurn = 0;
    room.hasDrawnCard = true;

    const p1 = new PlayerSession({ playerId: 'p1', playerName: 'P1', playerIndex: 0, socketId: 's1' });
    const p2 = new PlayerSession({ playerId: 'p2', playerName: 'P2', playerIndex: 1, socketId: 's2' });
    room.addPlayer(p1);
    room.addPlayer(p2);

    room.playerHands.set('p1', [card('hearts', '6')]);
    // p1 extends their OWN meld (in 1v1, p1 and p2 are opponents — see S-C5).
    room.playerMelds.set('p1', [[card('hearts', '3'), card('hearts', '4'), card('hearts', '5')]]);

    const ok = GameValidator.validateAddToMeld(room, 'p1', card('hearts', '6'), 0, 0);
    expect(ok.isValid).to.equal(true);

    // Card not in hand is rejected.
    const bad = GameValidator.validateAddToMeld(room, 'p1', card('spades', '9'), 0, 0);
    expect(bad.isValid).to.equal(false);

    // S-C5: cannot extend an opponent's meld.
    room.playerMelds.set('p2', [[card('clubs', '3'), card('clubs', '4'), card('clubs', '5')]]);
    const opponentMeld = GameValidator.validateAddToMeld(room, 'p1', card('hearts', '6'), 1, 0);
    expect(opponentMeld.isValid).to.equal(false);
  });
});
