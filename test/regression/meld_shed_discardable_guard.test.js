/* eslint-env mocha */

// "Keep a discardable card" guard (classic focus). A turn must end with a
// discard, so melding / adding cards may NOT strand the player on a hand with no
// legally-discardable card. The reported freeze: hold 3 cards after taking the
// pile, add 2 to a meld, and the lone leftover is a wild (classic never closes on
// a joker/2) or a single card with no Brazilia — every discard is rejected by the
// close rules and the turn wedges (no discard, no legal go-out). The server must
// reject + roll back such a meld, exactly like the empty-hand meld-out.
//
// Complements close_requirement_guard.test.js, which covers the EMPTY-hand
// (professional) meld-out; this covers the NON-EMPTY undiscardable case.

const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const { GameRoom, PlayerSession } = require('../../src/models');
const { GameRoomStatus } = require('../../src/constants');

const card = (suit, rank) => ({ suit, rank });

function makeRoom() {
  const room = new GameRoom({ roomId: 'shed-guard', maxPlayers: 2 });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.ruleset = 'classic';
  room.currentTurn = 0;
  room.hasDrawnCard = true;
  room.meldedThisTurn = false;
  // No pozzetto on the table, so a would-be close is gated purely on the Brazilia
  // requirement (isolates the "lone wild" / "no Brazilia" wedge from mustTakeWell).
  room.deadPiles = [];
  room.discardPile = [];

  for (let i = 0; i < 2; i += 1) {
    const playerId = `p${i + 1}`;
    room.addPlayer(new PlayerSession({
      playerId, playerName: `P${i + 1}`, playerIndex: i, socketId: `s${i + 1}`,
    }));
    room.playerHands.set(playerId, []);
    room.playerMelds.set(playerId, []);
    room.playerHasTakenPozzetto.set(playerId, false);
    room.playerDeadPileCount.set(playerId, 0);
    room.meldDirtyFlags.set(playerId, new Set());
  }
  // p1's team already has a 3-card run on the table to add onto.
  room.playerMelds.set('p1', [[card('spades', '7'), card('spades', '8'), card('spades', '9')]]);
  return room;
}

describe('meld-shed "keep a discardable card" guard (classic)', () => {
  // REPORTED LIVE, exact position: "I hold 2♠ and 3♥. My melds are a heart run
  // 4-5-6-7-8-9-10-J-Q-K and a spade run 5-6-7-8. I add the 3♥ to the heart run
  // and it refuses — the card jumps back with 'That meld would leave you no card
  // you can legally discard'."
  //
  // STRANDED means no exit AT ALL, and a hand has two: discarding the card, and
  // MELDING it away. The leftover 2♠ is a wild, so classic really does shut the
  // discard exit (never close on a joker/2) — but it drops straight onto either
  // run. The DEPLOYED build has no meld-out test at all, so it rolled the add
  // back; _handHasLegalMeldOut is the half that answers the second question.
  it('allows the add when the lone WILD left behind can be melded away', () => {
    const room = makeRoom();
    const heartRun = ['4','5','6','7','8','9','10','J','Q','K'].map((r) => card('hearts', r));
    const spadeRun = ['5','6','7','8'].map((r) => card('spades', r));
    room.playerMelds.set('p1', [heartRun, spadeRun]);
    room.playerMeldOrders.set('p1', [1, 2]);
    const three = card('hearts', '3');
    const two = card('spades', '2');
    room.playerHands.set('p1', [two, three]);

    const res = ActionHandlers.handleAddToMeld(room, 'p1', [three], 0, 0);

    expect(res.success, res.error).to.equal(true);
    expect(room.playerHands.get('p1')).to.have.length(1);
    expect(ActionHandlers._handHasLegalDiscard(room, 'p1'), 'classic will not close on a 2').to.equal(false);
    expect(ActionHandlers._handHasLegalMeldOut(room, 'p1'), 'but the 2♠ can be melded out').to.equal(true);
  });

  it('rejects & rolls back an ADD-TO-MELD that strands the player on a lone WILD', () => {
    const room = makeRoom();
    room.playerHands.set('p1', [card('spades', '5'), card('spades', '6'), card('hearts', '2')]);

    // 5♠6♠ extend 7♠8♠9♠ into a valid run, leaving only the wild 2♥ — which
    // classic can never discard to close.
    const res = ActionHandlers.handleAddToMeld(
      room, 'p1', [card('spades', '5'), card('spades', '6')], 0, 0
    );

    expect(res.success).to.equal(false);
    expect(res.reason).to.equal('mustKeepDiscard');
    // Fully rolled back: cards back in hand, meld back to its original 3 cards.
    expect(room.playerHands.get('p1')).to.have.length(3);
    expect(room.playerMelds.get('p1')[0]).to.have.length(3);
    expect(room.meldedThisTurn).to.equal(false);
  });

  it('rejects & rolls back an ADD-TO-MELD that strands the player on a single card with NO Brazilia', () => {
    const room = makeRoom();
    room.playerHands.set('p1', [card('spades', '5'), card('spades', '6'), card('diamonds', 'K')]);

    // Leftover K♦ is natural but the extended run is only 5 cards (no Brazilia), so
    // discarding it to go out is illegal — the turn would wedge.
    const res = ActionHandlers.handleAddToMeld(
      room, 'p1', [card('spades', '5'), card('spades', '6')], 0, 0
    );

    expect(res.success).to.equal(false);
    expect(res.reason).to.equal('mustKeepDiscard');
    expect(room.playerHands.get('p1')).to.have.length(3);
    expect(room.playerMelds.get('p1')[0]).to.have.length(3);
  });

  it('ALLOWS an ADD-TO-MELD that leaves 2+ cards (a normal discard still exists)', () => {
    const room = makeRoom();
    room.playerHands.set('p1', [
      card('spades', '5'), card('spades', '6'), card('diamonds', 'K'), card('diamonds', 'Q'),
    ]);

    const res = ActionHandlers.handleAddToMeld(
      room, 'p1', [card('spades', '5'), card('spades', '6')], 0, 0
    );

    expect(res.success).to.equal(true);
    expect(room.playerHands.get('p1')).to.have.length(2);
    expect(room.playerMelds.get('p1')[0]).to.have.length(5);
  });

  it('rejects & rolls back a PLAY-MELD that strands the player on a lone WILD', () => {
    const room = makeRoom();
    room.playerHands.set('p1', [
      card('spades', '3'), card('diamonds', '3'), card('clubs', '3'), card('hearts', '2'),
    ]);

    // Melding the set of 3s leaves only the wild 2♥ — a wedge in classic.
    const res = ActionHandlers.handlePlayMeld(
      room, 'p1', [card('spades', '3'), card('diamonds', '3'), card('clubs', '3')], undefined
    );

    expect(res.success).to.equal(false);
    expect(res.reason).to.equal('mustKeepDiscard');
    expect(room.playerHands.get('p1')).to.have.length(4);
    // Only the pre-existing run survives — the new set was rolled back.
    expect(room.playerMelds.get('p1')).to.have.length(1);
  });
});
