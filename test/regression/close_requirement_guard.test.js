/* eslint-env mocha */

// R2 close-requirement guard: a player may not go out by melding / going down /
// adding their LAST card(s) unless it is a legal close. A legal close needs a
// FINAL DISCARD (classic / professional-indirect), so those meld-outs are
// rejected and rolled back — the only meld-outs allowed are professional-DIRECT
// batida-al-volo (brazilia + well taken) and the brazilia-of-2s instant win, plus a
// takeable pozzetto that auto-refills the hand. Focus: professional ruleset.

const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const { GameRoom, PlayerSession } = require('../../src/models');
const { GameRoomStatus } = require('../../src/constants');

const card = (suit, rank) => ({ suit, rank });
const brazilia = (suit, rank) => Array.from({ length: 7 }, () => card(suit, rank));

function makeRoom({ maxPlayers = 4, ruleset = 'professional', professionalWellMode = 'indirect' } = {}) {
  const room = new GameRoom({ roomId: 'r2-guard', maxPlayers });
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
      playerId, playerName: `P${i + 1}`, playerIndex: i, socketId: `s${i + 1}`,
    }));
    room.playerHands.set(playerId, []);
    room.playerMelds.set(playerId, []);
    room.playerHasTakenPozzetto.set(playerId, false);
    room.playerDeadPileCount.set(playerId, 0);
    room.meldDirtyFlags.set(playerId, new Set());
  }
  return room;
}

describe('R2 close-requirement guard (professional focus)', () => {
  it('rejects & rolls back a meld that empties the hand with no Brazilia', () => {
    const room = makeRoom({ professionalWellMode: 'indirect' });
    const hand = [card('spades', '5'), card('hearts', '5'), card('diamonds', '5')]; // a set
    room.playerHands.set('p1', hand);

    const res = ActionHandlers.handlePlayMeld(room, 'p1', hand, undefined);

    expect(res.success).to.equal(false);
    expect(res.reason).to.equal('mustKeepDiscard');
    // Fully rolled back: cards back in hand, no meld persisted, turn flags intact.
    expect(room.playerHands.get('p1')).to.have.length(3);
    expect(room.playerMelds.get('p1')).to.have.length(0);
    expect(room.meldedThisTurn).to.equal(false);
    expect(room.lastMeldSnapshot).to.equal(null);
  });

  it('ALLOWS meld-out WITH a Brazilia + well taken in indirect mode too', () => {
    // PRODUCT DECISION: a meld-out closes the round in BOTH well modes. The
    // reference rules instead require a final discard to close in indirect, but
    // rejecting the meld rolled it back mid-turn and left the turn timer to
    // auto-discard a card the player had just melded — the reported bug.
    const room = makeRoom({ professionalWellMode: 'indirect' });
    room.deadPiles = []; // no well left to auto-take
    room.playerHasTakenPozzetto.set('teamA', true);
    room.playerDeadPileCount.set('teamA', 1);
    room.playerMelds.set('p1', [brazilia('hearts', '3')]);
    const hand = [card('spades', '5'), card('spades', '6'), card('spades', '7')]; // a run
    room.playerHands.set('p1', hand);

    const res = ActionHandlers.handlePlayMeld(room, 'p1', hand, undefined);

    expect(res.success).to.equal(true);
    expect(res.roundEnded).to.not.equal(undefined);
    expect(res.roundEnded.winnerId).to.equal('p1');
    expect(room.playerHands.get('p1')).to.have.length(0);
    expect(room.playerMelds.get('p1')).to.have.length(2);
  });

  it('ALLOWS a meld-out with a Brazilia when NO well is left to take', () => {
    // The opponents took both wells, so this side can never satisfy a
    // "take the well first" rule. GameValidator.validateDiscard already lets it
    // close by discarding its last card in exactly this position (the mustTakeWell
    // check is conditional on a well still being available), but _checkInstantEnd
    // demanded tookWell unconditionally — so the SAME position answered yes to a
    // discard-close and no to a meld-out, and the meld was rolled back mid-turn.
    const room = makeRoom({ professionalWellMode: 'indirect' });
    room.deadPiles = []; // both wells gone, taken by the other side
    room.playerHasTakenPozzetto.set('teamA', false);
    room.playerDeadPileCount.set('teamA', 0);
    room.playerMelds.set('p1', [brazilia('hearts', '3')]);
    const hand = [card('spades', '5'), card('spades', '6'), card('spades', '7')];
    room.playerHands.set('p1', hand);

    const res = ActionHandlers.handlePlayMeld(room, 'p1', hand, undefined);

    expect(res.success).to.equal(true);
    expect(res.roundEnded).to.not.equal(undefined);
    expect(res.roundEnded.winnerId).to.equal('p1');
    expect(room.playerHands.get('p1')).to.have.length(0);
  });

  it('still rejects a meld-out while a well IS available and untaken', () => {
    // The conditional must not become a blanket pass: with a well still on the
    // table and this side yet to take one, going out is not allowed.
    const room = makeRoom({ professionalWellMode: 'indirect' });
    room.deadPiles = [[card('clubs', '3')]]; // a well is still there
    room.playerHasTakenPozzetto.set('teamA', false);
    room.playerDeadPileCount.set('teamA', 0);
    room.playerMelds.set('p1', [brazilia('hearts', '3')]);
    const hand = [card('spades', '5'), card('spades', '6'), card('spades', '7')];
    room.playerHands.set('p1', hand);

    const res = ActionHandlers.handlePlayMeld(room, 'p1', hand, undefined);

    // The hand empties, so the well is auto-taken and the hand refills instead of
    // the round closing — either way it must NOT be a close.
    expect(res.roundEnded).to.equal(undefined);
  });

  it('still rejects a meld-out with NO Brazilia in indirect mode', () => {
    // The close requirements themselves are unchanged: a side without a
    // completed brazilia may not go out, so the meld is rolled back and the
    // player keeps a discardable card.
    const room = makeRoom({ professionalWellMode: 'indirect' });
    room.deadPiles = [];
    room.playerHasTakenPozzetto.set('teamA', true);
    room.playerDeadPileCount.set('teamA', 1);
    const hand = [card('spades', '5'), card('spades', '6'), card('spades', '7')];
    room.playerHands.set('p1', hand);

    const res = ActionHandlers.handlePlayMeld(room, 'p1', hand, undefined);

    expect(res.success).to.equal(false);
    expect(res.reason).to.equal('mustKeepDiscard');
    expect(room.playerHands.get('p1')).to.have.length(3);
  });

  it('ALLOWS meld-out in direct mode with a Brazilia + well taken (batida al volo)', () => {
    const room = makeRoom({ professionalWellMode: 'direct' });
    room.deadPiles = [];
    room.playerHasTakenPozzetto.set('teamA', true);
    room.playerDeadPileCount.set('teamA', 1);
    room.playerMelds.set('p1', [brazilia('hearts', '3')]);
    const hand = [card('spades', '5'), card('spades', '6'), card('spades', '7')];
    room.playerHands.set('p1', hand);

    const res = ActionHandlers.handlePlayMeld(room, 'p1', hand, undefined);

    expect(res.success).to.equal(true);
    expect(res.roundEnded).to.not.equal(undefined); // instant end (batida) fired
  });

  it('rejects & rolls back a GO-DOWN that empties the hand with no Brazilia', () => {
    const room = makeRoom({ professionalWellMode: 'indirect' });
    room.deadPiles = [];
    // A 5-card run clears the go-down minimum (>=50 pts) yet is <7 = no Brazilia.
    const run = [card('spades', '10'), card('spades', 'J'), card('spades', 'Q'), card('spades', 'K'), card('spades', 'A')];
    room.playerHands.set('p1', [...run]);
    const melds = [run];

    const res = ActionHandlers.handleGoingDown(room, 'p1', melds);

    expect(res.success).to.equal(false);
    expect(res.reason).to.equal('mustKeepDiscard');
    expect(room.playerHands.get('p1')).to.have.length(5); // full run rolled back
    expect(room.playerMelds.get('p1')).to.have.length(0);
    expect(room.meldedThisTurn).to.equal(false);
  });

  it('preserves the classic first-empty carve-out: melding the last cards auto-takes the well', () => {
    const room = makeRoom({ maxPlayers: 2, ruleset: 'classic' });
    const hand = [card('spades', '5'), card('hearts', '5'), card('diamonds', '5')];
    room.playerHands.set('p1', hand);

    const res = ActionHandlers.handlePlayMeld(room, 'p1', hand, undefined);

    expect(res.success).to.equal(true);
    expect(res.broadcast.pozzettoTaken).to.equal(2); // deadPile [3♣,4♣] refilled the hand
    expect(room.playerHands.get('p1')).to.have.length(2);
  });
});
