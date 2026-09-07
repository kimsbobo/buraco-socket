/**
 * Phase 0 — Quick-win regression tests
 *
 * These lock in the Phase 0 fixes from docs/PRODUCTION_FIX_PLAN.md:
 *   - S-C1: ActionHandlers.handleDrawCard must not throw a ReferenceError on a deck draw.
 *   - S-H8: a started room reports the IN_PROGRESS status (PLAYING constant does not exist).
 */

const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const { GameRoom, PlayerSession } = require('../../src/models');
const { GameRoomStatus } = require('../../src/constants');
const { Card } = require('../../src/models/Deck');

function makeStartedRoom() {
  const room = new GameRoom({ roomId: 'phase0', maxPlayers: 2 });
  room.addPlayer(new PlayerSession({ playerId: 'p1', playerName: 'Alice', playerIndex: 0, socketId: 's1' }));
  room.addPlayer(new PlayerSession({ playerId: 'p2', playerName: 'Bob', playerIndex: 1, socketId: 's2' }));
  room.startGame();
  room.dealCards();
  room.currentTurn = 0;
  room.hasDrawnCard = false;
  return room;
}

describe('Phase 0 regression', () => {
  describe('S-C1 — handleDrawCard deck draw does not throw', () => {
    it('returns success for a fromDeck=true draw (no ReferenceError on actualDrawnCard)', () => {
      const room = makeStartedRoom();
      const drawnCard = new Card('hearts', 'A');

      // Before the fix this threw `ReferenceError: actualDrawnCard is not defined`.
      const call = () => ActionHandlers.handleDrawCard(room, 'p1', true, drawnCard);
      expect(call).to.not.throw();

      const result = call();
      expect(result.success).to.equal(true);
      expect(result.toPlayer).to.have.property('card');
      // Opponents must not see the drawn card.
      expect(result.toOthers.card).to.equal(null);
    });
  });

  describe('S-H8 — matchmaking started-flag uses the real status constant', () => {
    it('GameRoomStatus.PLAYING is undefined and IN_PROGRESS is the real value', () => {
      expect(GameRoomStatus.PLAYING).to.equal(undefined);
      expect(GameRoomStatus.IN_PROGRESS).to.equal('inProgress');
    });

    it('a started room reports IN_PROGRESS (so gameStarted comparison is true)', () => {
      const room = makeStartedRoom();
      expect(room.status).to.equal(GameRoomStatus.IN_PROGRESS);
      // Mirrors MatchmakingService: gameStarted = room.status === GameRoomStatus.IN_PROGRESS
      expect(room.status === GameRoomStatus.IN_PROGRESS).to.equal(true);
    });
  });
});
