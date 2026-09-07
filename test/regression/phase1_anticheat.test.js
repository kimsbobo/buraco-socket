/**
 * Phase 1 — Server authority / anti-cheat regression tests.
 *
 * Locks in:
 *   - S-C5: a player cannot add cards to an opponent team's meld.
 *   - S-H2: going down validates meld structure + card ownership AND mutates state
 *           (removes cards from hand, stores melds). Fabricated melds are rejected.
 *   - S-H4: picking up the pile is rejected if the player has already drawn this turn.
 */

const { expect } = require('chai');
const GameValidator = require('../../src/validators/GameValidator');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const { GameRoom } = require('../../src/models');
const PlayerSession = require('../../src/models/PlayerSession');
const { GameRoomStatus } = require('../../src/constants');

const card = (suit, rank) => ({ suit, rank });

function makeRoom({ maxPlayers = 2, hasDrawnCard = true, ruleset = 'classic' } = {}) {
  const room = new GameRoom({ roomId: 'p1-room', maxPlayers });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.ruleset = ruleset;
  room.currentTurn = 0;
  room.hasDrawnCard = hasDrawnCard;
  for (let i = 0; i < maxPlayers; i++) {
    room.addPlayer(new PlayerSession({
      playerId: `p${i + 1}`, playerName: `P${i + 1}`, playerIndex: i, socketId: `s${i + 1}`,
    }));
  }
  return room;
}

describe('Phase 1 anti-cheat', () => {
  describe('S-C5 — add-to-meld team ownership', () => {
    it('rejects adding a card to an opponent (other team) meld', () => {
      // 4 players: teams are {0,2} and {1,3}. p1 (idx0) acts; target idx1 is the opponent team.
      const room = makeRoom({ maxPlayers: 4 });
      room.playerHands.set('p1', [card('spades', '9')]);
      // Opponent p2 (idx1) owns a valid set of 9s.
      room.playerMelds.set('p2', [[card('hearts', '9'), card('diamonds', '9'), card('clubs', '9')]]);

      const res = GameValidator.validateAddToMeld(room, 'p1', card('spades', '9'), 1, 0);

      expect(res.isValid).to.equal(false);
      expect(res.error).to.match(/own team/i);
    });

    it('allows adding to a partner (same team) meld', () => {
      const room = makeRoom({ maxPlayers: 4 });
      room.playerHands.set('p1', [card('spades', '9')]);
      // Partner p3 (idx2) is the same team as p1 (idx0).
      room.playerMelds.set('p3', [[card('hearts', '9'), card('diamonds', '9'), card('clubs', '9')]]);

      const res = GameValidator.validateAddToMeld(room, 'p1', card('spades', '9'), 2, 0);

      expect(res.isValid).to.equal(true);
    });
  });

  describe('S-H2 — going down validates and mutates', () => {
    it('rejects going down with cards not in hand (fabricated melds)', () => {
      const room = makeRoom();
      room.playerHands.set('p1', [card('hearts', '3')]); // does not hold the melds below
      const fabricated = [[card('spades', 'A'), card('hearts', 'A'), card('diamonds', 'A')]];

      const res = ActionHandlers.handleGoingDown(room, 'p1', fabricated);

      expect(res.success).to.equal(false);
      expect(res.error).to.match(/not in your hand/i);
    });

    it('rejects an opening meld below the minimum points', () => {
      const room = makeRoom();
      // Three low cards = 5+5+5 = 15 pts, well below the 50-pt minimum.
      const lowSet = [card('hearts', '3'), card('diamonds', '3'), card('clubs', '3')];
      room.playerHands.set('p1', [...lowSet]);

      const res = ActionHandlers.handleGoingDown(room, 'p1', [lowSet]);

      expect(res.success).to.equal(false);
      expect(res.error).to.match(/at least .* points/i);
    });

    it('accepts a valid opening meld and removes cards from hand + stores meld', () => {
      const room = makeRoom();
      // Set of Aces = 15*3 = 45... need >=50, so use a set of Aces (45) plus is short.
      // Use a 4-card set of Kings = 10*4 = 40 (still short). Use Aces x4 = 60 >= 50.
      const aces = [card('spades', 'A'), card('hearts', 'A'), card('diamonds', 'A'), card('clubs', 'A')];
      room.playerHands.set('p1', [...aces, card('spades', '7')]);
      // A takeable well makes going down to a single card legal (that last card
      // could be discarded onto the well), satisfying the keep-a-discardable-card
      // guard; the well is auto-taken only on an empty hand, so the 7♠ remains.
      room.deadPiles = [Array.from({ length: 11 }, (_, i) => card('clubs', String((i % 9) + 2)))];

      const res = ActionHandlers.handleGoingDown(room, 'p1', [aces]);

      expect(res.success).to.equal(true);
      // Cards removed from hand (only the 7 remains).
      const hand = room.playerHands.get('p1');
      expect(hand).to.have.lengthOf(1);
      expect(hand[0]).to.deep.equal(card('spades', '7'));
      // Meld stored authoritatively.
      expect(room.playerMelds.get('p1')).to.have.lengthOf(1);
      expect(room.playerMelds.get('p1')[0]).to.have.lengthOf(4);
    });

    it('rejects melding two copies of a card the player only holds once', () => {
      const room = makeRoom();
      // Hand has a single Ace of spades, but the meld lists it twice.
      room.playerHands.set('p1', [card('spades', 'A'), card('hearts', 'A'), card('diamonds', 'A')]);
      const cheat = [[card('spades', 'A'), card('spades', 'A'), card('hearts', 'A'), card('diamonds', 'A')]];

      const res = ActionHandlers.handleGoingDown(room, 'p1', cheat);

      expect(res.success).to.equal(false);
    });
  });

  describe('S-H4 — pickup rejected after already drawing', () => {
    it('rejects picking up the pile when hasDrawnCard is already true', () => {
      const room = makeRoom({ hasDrawnCard: true });
      const res = ActionHandlers.handlePickUpPile(room, 'p1', [card('diamonds', '5')]);

      expect(res.success).to.equal(false);
      expect(res.error).to.match(/already drawn/i);
    });

    it('allows picking up the pile when the player has not yet drawn', () => {
      const room = makeRoom({ hasDrawnCard: false });
      const res = ActionHandlers.handlePickUpPile(room, 'p1', [card('diamonds', '5')]);

      expect(res.success).to.equal(true);
    });
  });
});
