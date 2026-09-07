const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const { GameRoom, PlayerSession } = require('../../src/models');
const { Deck } = require('../../src/models/Deck');
const { GameRoomStatus } = require('../../src/constants');

const card = (suit, rank) => ({ suit, rank });
const pile = (n, suit) => Array.from({ length: n }, (_, i) => card(suit, String((i % 9) + 2)));

// A live 1v1 room with BOTH wells still on the table.
function makeRoom({ deadPiles = [pile(11, 'clubs'), pile(11, 'hearts')] } = {}) {
  const room = new GameRoom({ roomId: 'well-slots', maxPlayers: 2 });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.ruleset = 'classic';
  room.currentTurn = 0;
  room.deck = new Deck();
  room.deadPiles = deadPiles;
  room.discardPile = [];

  for (let i = 0; i < 2; i += 1) {
    const playerId = `p${i + 1}`;
    room.addPlayer(new PlayerSession({
      playerId,
      playerName: `P${i + 1}`,
      playerIndex: i,
      socketId: `s${i + 1}`,
    }));
    room.playerHands.set(playerId, [card('hearts', '5')]);
    room.playerMelds.set(playerId, []);
    room.playerHasTakenPozzetto.set(playerId, false);
    room.playerDeadPileCount.set(playerId, 0);
    room.meldDirtyFlags.set(playerId, new Set());
  }
  return room;
}

// deadPileCounts, exactly as every state frame builds it.
const counts = (room) => room.deadPiles.map((p) => (Array.isArray(p) ? p.length : 0));

describe('#a taken well keeps its SLOT (the index is its identity on the wire)', () => {
  it('empties the slot in place instead of renumbering the survivor', () => {
    const room = makeRoom();
    const taken = room.deadPiles[0];

    ActionHandlers._emptyDeadPileSlot(room, taken);

    expect(counts(room)).to.deep.equal([0, 11]);
    // The survivor is still the SECOND slot — the clients draw index 0 as the
    // vertical well and index 1 as the horizontal one, and the take animation
    // addresses piles by that index. Splicing made the survivor become index 0
    // mid-round, which flipped its orientation AND let a flight that captured
    // index 0 before the animation empty the survivor when it landed — both
    // wells then vanished from the opponent's board.
    expect(room.deadPiles[1]).to.have.length(11);
  });

  it('_autoTakeDeadIfNeeded reports the real count and leaves the other well', () => {
    const room = makeRoom();
    room.playerHands.set('p1', []);
    // Team p1 holds a brazilia so the well is legally takeable on an empty hand.
    room.playerMelds.set('p1', [pile(7, 'spades')]);

    const result = ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', false);

    expect(result).to.not.equal(null);
    expect(result.takenCount).to.equal(11, 'takenCount must be read BEFORE the slot is emptied');
    expect(room.playerHands.get('p1')).to.have.length(11);
    expect(counts(room)).to.deep.equal([0, 11]);
  });

  it('a second take empties the second slot, and only then is nothing left', () => {
    const room = makeRoom();
    ActionHandlers._emptyDeadPileSlot(room, room.deadPiles[0]);
    expect(ActionHandlers._anyDeadPileRemains(room)).to.equal(true);

    ActionHandlers._emptyDeadPileSlot(room, room.deadPiles[1]);
    expect(ActionHandlers._anyDeadPileRemains(room)).to.equal(false);
    expect(counts(room)).to.deep.equal([0, 0]);
    // Slots survive, so "no wells left" can no longer be asked as `length === 0`.
    expect(room.deadPiles).to.have.length(2);
  });

  it('the stock promotion empties its slot too, and never finalizes early', () => {
    const room = makeRoom({ deadPiles: [[], pile(11, 'hearts')] });
    room.deck.cards = []; // stock exhausted (count === 0)

    const result = ActionHandlers._refillStockOrEndRound(room);

    expect(result).to.equal(null, 'play continues on a promoted well');
    expect(room.deck.cards).to.have.length(11);
    expect(counts(room)).to.deep.equal([0, 0]);
    expect(ActionHandlers._anyDeadPileRemains(room)).to.equal(false);
  });

  it('is a no-op for a pile that is not on this table', () => {
    const room = makeRoom();
    ActionHandlers._emptyDeadPileSlot(room, pile(11, 'spades'));
    expect(counts(room)).to.deep.equal([11, 11]);
  });
});
