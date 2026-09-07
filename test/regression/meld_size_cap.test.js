/**
 * validateMeld had a minimum (>=3) but no maximum, so a malicious client could
 * submit a huge array and force per-card work (Set build, ownership scan) before
 * rejection. A single meld comes from the hand (<= ~22 cards), so anything far
 * beyond that is malformed. Reject it cheaply up front.
 *
 * This is a DoS guard, not a rule change: legitimate melds (3..hand-size) are
 * unaffected, and the real anti-cheat gate (ownership via _playerHasCards) is
 * unchanged.
 */

const { expect } = require('chai');
const GameValidator = require('../../src/validators/GameValidator');
const GameRoom = require('../../src/models/GameRoom');
const PlayerSession = require('../../src/models/PlayerSession');

function inProgressRoom() {
  const room = new GameRoom({ roomId: 'cap', maxPlayers: 2 });
  room.addPlayer(new PlayerSession({ playerId: 'p1', playerName: 'A', playerIndex: 0, socketId: 's1' }));
  room.addPlayer(new PlayerSession({ playerId: 'p2', playerName: 'B', playerIndex: 1, socketId: 's2' }));
  room.startGame();
  room.currentTurn = 0;
  room.hasDrawnCard = true;
  return room;
}

describe('#meld size cap (DoS guard)', () => {
  it('rejects an absurdly large meld array up front', () => {
    const room = inProgressRoom();
    const huge = Array.from({ length: 5000 }, (_, i) => ({ suit: 'hearts', rank: '3', _i: i }));
    const result = GameValidator.validateMeld(room, 'p1', huge);
    expect(result.isValid).to.equal(false);
    expect(result.error).to.match(/too many/i);
  });

  it('still accepts a normal-size valid meld', () => {
    const room = inProgressRoom();
    const cards = [
      { suit: 'hearts', rank: '3' },
      { suit: 'hearts', rank: '4' },
      { suit: 'hearts', rank: '5' },
    ];
    room.playerHands.set('p1', cards);
    const result = GameValidator.validateMeld(room, 'p1', cards);
    expect(result.isValid).to.equal(true);
  });
});
