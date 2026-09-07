/* eslint-env mocha */

/**
 * EXHAUSTION END (product rule, 2026-08-20).
 *
 * When the stock is dead and no pozzetto is left, the table is out of cards to
 * draw — but the player whose turn it is has NOT finished playing. The old rule
 * ended the round the instant they reached for the discard pile, taking away a
 * hand they had every right to play. Now:
 *
 *   * they may TAKE the pile and play the turn out,
 *   * they may meld / add to melds,
 *   * and the round ends on their DISCARD — nobody after them gets a turn.
 *
 * Every remaining hand is then charged to its owner.
 */
const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const { GameRoom, PlayerSession } = require('../../src/models');
const { Card, Deck } = require('../../src/models/Deck');
const { GameRoomStatus } = require('../../src/constants');

const c = (rank, suit) => new Card(suit, rank);

/** Seated room whose stock is permanently dead: empty deck, no wells left. */
function exhaustedRoom() {
  const room = new GameRoom({ roomId: 'exhausted', maxPlayers: 2 });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.ruleset = 'classicWithNoJoker';
  room.professionalWellMode = 'indirect';
  room.currentTurn = 0;
  room.hasDrawnCard = false;
  for (let i = 0; i < 2; i += 1) {
    room.addPlayer(
      new PlayerSession({
        playerId: `p${i + 1}`,
        playerName: `P${i + 1}`,
        playerIndex: i,
        socketId: `s${i + 1}`,
      })
    );
    room.playerHands.set(`p${i + 1}`, []);
    room.playerMelds.set(`p${i + 1}`, []);
  }
  room.deck = new Deck();
  room.deck.cards = [];
  room.deadPiles = [];
  return room;
}

describe('#a dead stock ends the round on the DISCARD, not on the take', () => {
  it('the pile can still be taken when the stock is dead', () => {
    const room = exhaustedRoom();
    expect(ActionHandlers._stockIsDead(room)).to.equal(true);
    const top = c('9', 'clubs');
    room.discardPile = [c('4', 'spades'), top];
    room.playerHands.set('p1', [c('K', 'hearts'), c('Q', 'hearts')]);

    const res = ActionHandlers.handlePickUpPile(room, 'p1', room.discardPile.slice());

    expect(res.success, res.error).to.equal(true);
    expect(
      res.roundEnded,
      'taking the pile must NOT end the round any more'
    ).to.equal(undefined);
  });

  it('the discard that follows closes the round, and nobody else plays', () => {
    const room = exhaustedRoom();
    room.discardPile = [];
    room.hasDrawnCard = true; // they already took the pile this turn
    const spare = c('K', 'hearts');
    room.playerHands.set('p1', [spare, c('Q', 'hearts'), c('J', 'hearts')]);
    room.playerHands.set('p2', [c('3', 'clubs'), c('4', 'clubs')]);
    const turnBefore = room.currentTurn;

    const res = ActionHandlers.handleDiscard(room, 'p1', spare);

    expect(res.success, res.error).to.equal(true);
    expect(res.roundEnded, 'the round closed on the discard').to.not.equal(undefined);
    expect(res.turnChanged, 'and the turn never moved on').to.equal(undefined);
    expect(room.currentTurn).to.equal(turnBefore);
  });

  it('nobody closed it, so no hand is charged', () => {
    const room = exhaustedRoom();
    room.discardPile = [];
    room.hasDrawnCard = true;
    const spare = c('4', 'spades'); // 5 points
    room.playerHands.set('p1', [spare, c('K', 'hearts')]); // keeps the K = 10
    room.playerHands.set('p2', [c('A', 'clubs')]); // 15

    const res = ActionHandlers.handleDiscard(room, 'p1', spare);

    const scores = res.roundEnded?.playerScores || [];
    // Product decision 2026-08-27: "Jika game tertutup bukan oleh pemain,
    // artinya tidak ada kalkulasi pemotongan dari score ditangan". An exhaustion
    // end is nobody's batida — the discarder still holds a K and the opponent an
    // ace — so neither is punished for the hand they were dealt.
    expect(scores[0].handPenalty, 'the discarder keeps their K for free').to.equal(0);
    expect(scores[1].handPenalty, 'and the opponent their ace').to.equal(0);
  });

  it('a discard that COLLECTS the last well does not end the round', () => {
    // The trap this rule walks into: the well was still on the table when the
    // player threw, and taking it is what emptied the last dead pile. Ending on
    // "the stock is now spent" would take away the eleven cards they earned with
    // that very discard and charge them back as a hand penalty.
    const room = exhaustedRoom();
    room.deadPiles = [Array.from({ length: 11 }, () => c('3', 'clubs'))];
    room.hasDrawnCard = true;
    const last = c('K', 'hearts');
    room.playerHands.set('p1', [last]);
    room.playerHands.set('p2', [c('4', 'clubs'), c('5', 'clubs')]);

    const res = ActionHandlers.handleDiscard(room, 'p1', last);

    expect(res.broadcast.pozzettoTaken, 'the well was collected').to.equal(11);
    expect(res.roundEnded, 'and the round carries on').to.equal(undefined);
    expect(room.playerHands.get('p1')).to.have.length(11);
    expect(res.turnChanged, 'the turn passes as normal').to.not.equal(undefined);
  });

  it('a genuine go-out still scores as a go-out, not an exhaustion end', () => {
    // The empty-hand batida check runs BEFORE the exhaustion branch.
    const room = exhaustedRoom();
    room.discardPile = [];
    room.hasDrawnCard = true;
    room.playerMelds.set('p1', [
      ['3', '4', '5', '6', '7', '8', '9'].map((r) => c(r, 'hearts')),
    ]);
    ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'indirect');
    const last = c('K', 'spades');
    room.playerHands.set('p1', [last]);
    room.playerHands.set('p2', [c('3', 'clubs')]);

    const res = ActionHandlers.handleDiscard(room, 'p1', last);

    expect(res.success, res.error).to.equal(true);
    expect(res.roundEnded).to.not.equal(undefined);
    expect(
      res.roundEnded.winnerId ?? res.roundEnded.winner,
      'the closer is credited'
    ).to.not.equal(undefined);
  });
});
