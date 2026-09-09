/* eslint-env mocha */

/**
 * MINIMUM MELD RULE (product rule, 2026-08-20).
 *
 * Once a side's cumulative score passes 1000, its FIRST going-down of a round
 * must be worth at least 75 points. Melds stay provisional until the turn ends:
 * what counts is the TOTAL laid down across the turn, and the verdict lands on
 * the discard (or on the timeout that discards for you).
 *
 *   pass -> the melds stand, and the requirement is spent for that round
 *   fail -> every card laid this turn goes back to the hand and the SIDE's bar
 *           rises by 20. NOTHING is charged (2026-09-01: the 100-point charge
 *           was removed; the card-return and the raised bar are the whole cost)
 *
 * The bar returns to 75 at the next deal. It is a general rule: direct and
 * indirect, every ruleset.
 */
const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const { GameRoom, PlayerSession } = require('../../src/models');
const { Card, Deck } = require('../../src/models/Deck');
const { GameRoomStatus } = require('../../src/constants');

const c = (rank, suit) => new Card(suit, rank);

function room2({ ruleset = 'classicWithNoJoker', score = 1000 } = {}) {
  const room = new GameRoom({ roomId: 'min-meld', maxPlayers: 2 });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.ruleset = ruleset;
  room.currentTurn = 0;
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
  room.cumulativeTeamScores.set('teamA', score);
  return room;
}

/** Lay `cards` as a new meld the way the handlers do, and record the turn. */
function layDown(room, playerId, cards) {
  const melds = room.playerMelds.get(playerId) || [];
  melds.push([...cards]);
  room.playerMelds.set(playerId, melds);
  const orders = room.playerMeldOrders.get(playerId) || [];
  orders.push(orders.length + 1);
  room.playerMeldOrders.set(playerId, orders);
  ActionHandlers._trackTurnMeldPoints(room, playerId, cards);
}

describe('#minimum meld once a side is past 1000', () => {
  it('does not arm below 1000', () => {
    const room = room2({ score: 999 });
    ActionHandlers._startTurnForPlayer(room, 'p1');
    // `== null` in the rule catches undefined too; this room was built by hand
    // rather than through startGame(), so the key was never seeded.
    expect(room.teamRequiredMeldPoints.get('teamA') ?? null).to.equal(null);
    layDown(room, 'p1', [c('3', 'hearts'), c('4', 'hearts'), c('5', 'hearts')]);
    expect(ActionHandlers._applyMinimumMeldRule(room, 'p1')).to.equal(null);
  });

  it('the TOTAL of the turn counts, not each meld on its own', () => {
    // 30 then 45 is a pass, even though neither meld reaches 75 alone.
    const room = room2();
    ActionHandlers._startTurnForPlayer(room, 'p1');
    layDown(room, 'p1', [c('K', 'hearts'), c('K', 'spades'), c('K', 'clubs')]); // 30
    layDown(room, 'p1', [c('A', 'hearts'), c('A', 'spades'), c('A', 'clubs')]); // 45
    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(75);

    const verdict = ActionHandlers._applyMinimumMeldRule(room, 'p1');

    expect(verdict.satisfied).to.equal(true);
    expect(room.teamTurnPenalty.get('p1') || 0).to.equal(0);
    expect(room.playerMelds.get('p1'), 'the melds stand').to.have.length(2);
  });

  it('falling short raises the bar and HANDS THE CARDS BACK, charging nothing', () => {
    const room = room2();
    ActionHandlers._startTurnForPlayer(room, 'p1');
    const short = [c('3', 'hearts'), c('4', 'hearts'), c('5', 'hearts')]; // 15
    room.playerHands.set('p1', [c('9', 'clubs')]);
    layDown(room, 'p1', short);

    const verdict = ActionHandlers._applyMinimumMeldRule(room, 'p1');

    expect(verdict.satisfied).to.equal(false);
    // 2026-09-01: no money changes hands. The key stays on the wire at 0 so a
    // client built against the charging server does not render "null deducted".
    expect(verdict.penalty).to.equal(0);
    expect(room.teamTurnPenalty.get('p1') || 0).to.equal(0);
    expect(room.teamRequiredMeldPoints.get('teamA')).to.equal(95);
    expect(room.playerMelds.get('p1'), 'the meld is gone from the table').to.have.length(0);
    expect(
      room.playerHands.get('p1').map((x) => x.rank).sort(),
      'and every card is back in hand'
    ).to.deep.equal(['3', '4', '5', '9']);
  });

  it('an ADD-to-meld that falls short only takes back what it added', () => {
    const room = room2();
    ActionHandlers._startTurnForPlayer(room, 'p1');
    const existing = [c('7', 'spades'), c('8', 'spades'), c('9', 'spades')];
    room.playerMelds.set('p1', [existing]);
    room.playerMeldOrders.set('p1', [1]);
    const added = c('10', 'spades');
    existing.push(added);
    ActionHandlers._trackTurnMeldPoints(room, 'p1', [added]);
    room.playerHands.set('p1', []);

    ActionHandlers._applyMinimumMeldRule(room, 'p1');

    expect(
      room.playerMelds.get('p1')[0],
      'the meld underneath survives'
    ).to.have.length(3);
    expect(room.playerHands.get('p1')).to.have.length(1);
  });

  it('once met, later melds in the same round are free', () => {
    const room = room2();
    ActionHandlers._startTurnForPlayer(room, 'p1');
    layDown(room, 'p1', [c('A', 'hearts'), c('A', 'spades'), c('A', 'clubs'), c('A', 'diamonds'), c('K', 'hearts'), c('K', 'spades')]); // 80
    expect(ActionHandlers._applyMinimumMeldRule(room, 'p1').satisfied).to.equal(true);

    // A later turn lays a trivial meld — no bar, no penalty.
    ActionHandlers._startTurnForPlayer(room, 'p1');
    layDown(room, 'p1', [c('3', 'clubs'), c('4', 'clubs'), c('5', 'clubs')]);
    expect(ActionHandlers._applyMinimumMeldRule(room, 'p1')).to.equal(null);
    expect(room.teamTurnPenalty.get('p1') || 0).to.equal(0);
  });

  it('a turn that lays NOTHING is never charged', () => {
    const room = room2();
    ActionHandlers._startTurnForPlayer(room, 'p1');
    expect(ActionHandlers._applyMinimumMeldRule(room, 'p1')).to.equal(null);
    expect(room.teamTurnPenalty.get('p1') || 0).to.equal(0);
    expect(room.teamRequiredMeldPoints.get('teamA')).to.equal(75);
  });

  it('2v2: a turn penalty on the PARTNER\'s key reaches the scoreboard', () => {
    // The minimum-meld rule stopped charging on 2026-09-01, but the AGGREGATION
    // is still live: `teamTurnPenalty` is keyed by player, FailureManager
    // restores rooms persisted while the charge was live, and the round-over
    // scoring used to read the key off the team LEAD alone — so a charge sitting
    // on the PARTNER's key quietly vanished from the board AND from the ledger.
    // Two halves here: the rule charges nothing, and a charge that IS present is
    // still summed off every seat.
    const room = new GameRoom({ roomId: 'min-meld-2v2', maxPlayers: 4 });
    room.status = GameRoomStatus.IN_PROGRESS;
    room.ruleset = 'classicWithNoJoker';
    for (let i = 0; i < 4; i += 1) {
      room.addPlayer(
        new PlayerSession({
          playerId: `q${i + 1}`,
          playerName: `Q${i + 1}`,
          playerIndex: i,
          socketId: `t${i + 1}`,
        })
      );
      room.playerHands.set(`q${i + 1}`, []);
      room.playerMelds.set(`q${i + 1}`, []);
    }
    room.cumulativeTeamScores.set('teamA', 1000);

    // q3 is q1's PARTNER (seats 0 and 2 are teamA) and it is q3 who falls short.
    ActionHandlers._startTurnForPlayer(room, 'q3');
    ActionHandlers._trackTurnMeldPoints(room, 'q3', [
      c('3', 'hearts'),
      c('4', 'hearts'),
      c('5', 'hearts'),
    ]);
    const verdict = ActionHandlers._applyMinimumMeldRule(room, 'q3');
    expect(verdict.satisfied, 'they did fall short').to.equal(false);
    expect(
      room.teamTurnPenalty.get('q3') || 0,
      'and falling short costs the partner nothing'
    ).to.equal(0);
    expect(
      ActionHandlers._computeScores(room, 'q2', 'indirect').teamScores.teamA.turnPenalty
    ).to.equal(0);

    // Now plant a charge on the PARTNER's key the way a restored room carries
    // one, and prove the aggregation still finds it.
    room.teamTurnPenalty.set('q3', 100);
    const { playerScores, teamScores } = ActionHandlers._computeScores(room, 'q2', 'indirect');

    expect(
      playerScores[2].turnPenalty,
      'the partner is charged on their own line'
    ).to.equal(100);
    expect(playerScores[0].turnPenalty, 'and the lead is not').to.equal(0);

    // THE SIDE'S OWN LINE. This is the assertion the fix was missing: the
    // per-player loop was corrected but the team aggregate still read
    // teamTurnPenalty.get(lead.playerId), which is 0 whenever the PARTNER is the
    // one who fell short. teamScores[*].total is what _finalizeWith banks into
    // cumulativeTeamScores and what _notifyBackendGameResult ships to the payout
    // webhook, so the 100 was not merely missing from a board — it was missing
    // from the ledger, and the board contradicted its own player rows.
    expect(
      teamScores.teamA.turnPenalty,
      'the side carries its partner\'s charge too'
    ).to.equal(100);
    // 2026-08-27 walked the 2026-08-23 rule back: a turn penalty DENTS the
    // round, it does not void it. Only the two obligations — a well and a
    // brazilia — void, and they now stack at -100 each.
    //
    // This fixture happens to fail BOTH obligations, so it IS voided, and since
    // 2026-09-02 a void no longer charges the hand — which is why `total` is no
    // longer simply `rawTotal`. The two now differ by exactly the hand penalty,
    // and asserting that is stronger than the old equality, which only held by
    // coincidence. The point of THIS test is the turnPenalty above reaching the
    // side's own line, and it still does.
    expect(
      teamScores.teamA.total,
      'a voided round is the flat charge minus the turn penalty, hand-free'
    ).to.equal(
      2 * ActionHandlers.ROUND_VOID_CHARGE - teamScores.teamA.turnPenalty
    );
    expect(
      teamScores.teamA.rawTotal - teamScores.teamA.total,
      'and they differ by exactly the hand the void forgives'
    ).to.equal(-teamScores.teamA.handPenalty);
    expect(
      teamScores.teamA.rawTotal,
      'and the raw figure still carries the charge'
    ).to.equal(
      teamScores.teamA.meldPoints +
        teamScores.teamA.buracoBonus +
        teamScores.teamA.pozzettoBonus +
        teamScores.teamA.goOutBonus -
        teamScores.teamA.handPenalty -
        100 -
        teamScores.teamA.noBraziliaPenalty
    );
  });

  it('2v2: BOTH seats falling short compounds the BAR, not a charge', () => {
    // Two failed going-downs in a round is unusual but entirely legal. What
    // compounds is the side's bar: 75 -> 95 -> 115. Nothing is charged.
    const room = new GameRoom({ roomId: 'min-meld-both', maxPlayers: 4 });
    room.status = GameRoomStatus.IN_PROGRESS;
    room.ruleset = 'classicWithNoJoker';
    for (let i = 0; i < 4; i += 1) {
      room.addPlayer(
        new PlayerSession({
          playerId: `r${i + 1}`,
          playerName: `R${i + 1}`,
          playerIndex: i,
          socketId: `u${i + 1}`,
        })
      );
      room.playerHands.set(`r${i + 1}`, []);
      room.playerMelds.set(`r${i + 1}`, []);
    }
    room.cumulativeTeamScores.set('teamA', 1000);

    for (const seat of ['r1', 'r3']) {
      ActionHandlers._startTurnForPlayer(room, seat);
      ActionHandlers._trackTurnMeldPoints(room, seat, [
        c('3', 'hearts'),
        c('4', 'hearts'),
        c('5', 'hearts'),
      ]);
      ActionHandlers._applyMinimumMeldRule(room, seat);
    }

    expect(
      room.teamRequiredMeldPoints.get('teamA'),
      'the bar climbed once per failure'
    ).to.equal(115);

    const { teamScores } = ActionHandlers._computeScores(room, 'r2', 'indirect');
    expect(teamScores.teamA.turnPenalty, 'and the side pays nothing').to.equal(0);
  });

  it('the raised bar goes back to 75 at the next deal', () => {
    const room = room2();
    ActionHandlers._startTurnForPlayer(room, 'p1');
    layDown(room, 'p1', [c('3', 'hearts'), c('4', 'hearts'), c('5', 'hearts')]);
    ActionHandlers._applyMinimumMeldRule(room, 'p1');
    expect(room.teamRequiredMeldPoints.get('teamA')).to.equal(95);

    room.startGame(true);

    expect(
      room.teamRequiredMeldPoints.get('teamA'),
      'a new deal starts the bar over'
    ).to.equal(null);
    ActionHandlers._startTurnForPlayer(room, 'p1');
    expect(room.teamRequiredMeldPoints.get('teamA')).to.equal(75);
  });

  it('binds the FIRST player of a round, who never passes through turn start', () => {
    // _startTurnForPlayer only runs after a nextTurn(), so the opening actor of
    // a round never went through it. Arming there alone let their first
    // going-down slip under the rule entirely.
    const room = room2();
    // NOTE: deliberately no _startTurnForPlayer call — this is the opening turn.
    layDown(room, 'p1', [c('3', 'hearts'), c('4', 'hearts'), c('5', 'hearts')]);

    const verdict = ActionHandlers._applyMinimumMeldRule(room, 'p1');

    expect(verdict, 'the rule armed itself').to.not.equal(null);
    expect(verdict.satisfied).to.equal(false);
    expect(room.teamRequiredMeldPoints.get('teamA'), 'and the bar rose').to.equal(95);
    expect(room.teamTurnPenalty.get('p1') || 0).to.equal(0);
  });

  it('handing a meld back keeps the dirty-flag INDICES pointing at the right melds', () => {
    // meldDirtyFlags stores indices, so splicing a meld out shifts every index
    // above it. Left alone, the flags re-point at their neighbours and a clean
    // canasta scores as dirty (or the reverse).
    const room = room2();
    ActionHandlers._startTurnForPlayer(room, 'p1');
    const laidThisTurn = [c('3', 'hearts'), c('4', 'hearts'), c('5', 'hearts')];
    const preExisting = [c('7', 'spades'), c('8', 'spades'), c('9', 'spades')];
    room.playerMelds.set('p1', [laidThisTurn, preExisting]);
    room.playerMeldOrders.set('p1', [1, 2]);
    // The PRE-EXISTING meld (index 1) is the dirty one.
    room.meldDirtyFlags.set('p1', new Set([1]));
    ActionHandlers._trackTurnMeldPoints(room, 'p1', laidThisTurn);
    room.playerHands.set('p1', []);

    ActionHandlers._applyMinimumMeldRule(room, 'p1');

    expect(room.playerMelds.get('p1'), 'only the returned meld left').to.have.length(1);
    // The container now maps index -> worst grade ('semi' | 'dirty'); the
    // shift must carry the GRADE across, not just the index.
    expect(
      [...room.meldDirtyFlags.get('p1').entries()],
      'the surviving meld is still the dirty one, at its new index'
    ).to.deep.equal([[0, 'dirty']]);
  });

  it('a short meld cannot BUY the pozzetto on the way out', () => {
    // The exploit the audit order exists to close: a side that cannot reach the
    // required points lays a junk meld, discards its last card, and collects the
    // well on the way out. The meld is rolled back — but the pozzetto it bought
    // would be kept, and a well for the price of one wasted turn is a bargain,
    // so it would be the correct play. Auditing BEFORE the hand-over leaves the returned
    // cards in hand, so there is no empty hand to give a well to.
    const room = room2();
    room.hasDrawnCard = true; // they have already taken their card this turn
    room.deck = new Deck();
    room.deck.cards = [c('7', 'clubs')];
    room.deadPiles = [Array.from({ length: 11 }, () => c('3', 'clubs'))];
    ActionHandlers._startTurnForPlayer(room, 'p1');
    const short = [c('3', 'hearts'), c('4', 'hearts'), c('5', 'hearts')]; // 15
    layDown(room, 'p1', short);
    const last = c('K', 'spades');
    room.playerHands.set('p1', [last]);

    const res = ActionHandlers.handleDiscard(room, 'p1', last);

    expect(res.success, res.error).to.equal(true);
    expect(res.broadcast.pozzettoTaken, 'no well was handed over').to.equal(undefined);
    expect(
      (room.deadPiles || []).filter((p) => p.length).length,
      'and it is still on the table'
    ).to.equal(1);
    expect(
      room.playerHands.get('p1'),
      'the hand holds the returned meld, nothing more'
    ).to.have.length(3);
    expect(room.playerMelds.get('p1')).to.have.length(0);
  });

  it('a missed limit costs no points at all', () => {
    // The whole point of the 2026-09-01 change: a going-down that falls short
    // must leave the side EXACTLY where a side that never attempted one stands.
    // Every card comes home, so there is nothing left to differ but the bar.
    const play = (goDownShort) => {
      const room = room2();
      room.hasDrawnCard = true;
      room.deck = new Deck();
      room.deck.cards = [c('7', 'clubs')];
      ActionHandlers._startTurnForPlayer(room, 'p1');
      const short = [c('3', 'hearts'), c('4', 'hearts'), c('5', 'hearts')]; // 15
      const discard = c('K', 'spades');
      const keep = c('9', 'diamonds');
      if (goDownShort) {
        room.playerHands.set('p1', [discard, keep]);
        layDown(room, 'p1', short);
      } else {
        room.playerHands.set('p1', [...short, discard, keep]);
      }
      const res = ActionHandlers.handleDiscard(room, 'p1', discard);
      expect(res.success, res.error).to.equal(true);
      return room;
    };

    const tried = play(true);
    const abstained = play(false);

    expect(tried.teamTurnPenalty.get('p1') || 0, 'nothing is charged').to.equal(0);
    expect(
      tried.playerHands.get('p1').map((x) => x.rank).sort(),
      'the short meld came home'
    ).to.deep.equal(['3', '4', '5', '9']);
    expect(tried.playerMelds.get('p1')).to.have.length(0);
    expect(
      tried.teamRequiredMeldPoints.get('teamA'),
      'the bar is the only thing that moved'
    ).to.equal(95);
    expect(abstained.teamRequiredMeldPoints.get('teamA')).to.equal(75);

    const side = (room) =>
      ActionHandlers._computeScores(room, 'p1', 'indirect').teamScores.teamA;
    expect(side(tried).turnPenalty).to.equal(0);
    expect(
      side(tried).total,
      'and the scoreboard cannot tell the two rooms apart'
    ).to.equal(side(abstained).total);
  });

  it('the bar is audited on a MELD-OUT close, not just a discard', () => {
    // THE HOLE: _applyMinimumMeldRule used to be called from handleDiscard and
    // nowhere else, while every close that does NOT pass through a discard goes
    // through _checkInstantEnd. A side past 1000 could therefore lay a 50-point
    // run against a 75 bar, meld out on it, and bank the round with its short
    // melds standing and the bar never escalated.
    const room = room2();
    room.hasDrawnCard = true;
    room.deck = new Deck();
    room.deck.cards = [c('7', 'clubs')];
    // No well left to owe, so the close is otherwise legal.
    room.deadPiles = [[], []];
    room.playerHasTakenPozzetto.set('p1', true);
    ActionHandlers._startTurnForPlayer(room, 'p1');

    // The brazilia that makes the close legal was laid on an EARLIER turn (so
    // it earns nothing this turn — since 2026-09-05 a fresh buraco's bonus
    // counts toward the bar, and a seven-card run would clear 75 on its own).
    room.playerMelds.set('p1', [
      [
        c('4', 'hearts'),
        c('5', 'hearts'),
        c('6', 'hearts'),
        c('7', 'hearts'),
        c('8', 'hearts'),
        c('9', 'hearts'),
        c('10', 'hearts'),
      ],
    ]);
    room.playerMeldOrders.set('p1', [1]);
    // This turn's going-down: 8-9-10-J-Q, worth 50 — enough to go down at
    // all, under the 75 bar — and it empties the hand.
    const short = [c('8', 'clubs'), c('9', 'clubs'), c('10', 'clubs'), c('J', 'clubs'), c('Q', 'clubs')];
    room.playerHands.set('p1', [...short]);

    const res = ActionHandlers.handleGoingDown(room, 'p1', [short]);

    expect(res.success, res.error).to.equal(true);
    expect(res.roundEnded, 'the round must NOT close under the bar').to.equal(undefined);
    expect(res.broadcast.minimumMeld, 'and the client is told why').to.include({
      satisfied: false,
      meldPoints: 50,
      required: 75,
    });
    expect(room.teamRequiredMeldPoints.get('teamA'), 'the bar escalated').to.equal(95);
    expect(room.playerMelds.get('p1'), 'the short meld came off the table').to.have.length(1);
    expect(room.playerHands.get('p1'), 'and back into the hand').to.have.length(5);
    expect(room.status, 'the room is still live').to.not.equal('finished');
  });

  it('a legitimate 30-then-45 turn is NOT confiscated mid-turn', () => {
    // The audit sits INSIDE the close branch of _checkInstantEnd on purpose.
    // _checkInstantEnd runs after EVERY meld action, so auditing above that
    // branch would confiscate the first half of a turn that clears the bar on
    // its TOTAL — the rule this file's second test exists to protect.
    const room = room2();
    room.hasDrawnCard = true;
    room.deck = new Deck();
    room.deck.cards = [c('7', 'clubs')];
    ActionHandlers._startTurnForPlayer(room, 'p1');
    const kings = [c('K', 'hearts'), c('K', 'spades'), c('K', 'clubs')]; // 30
    const aces = [c('A', 'hearts'), c('A', 'spades'), c('A', 'clubs')]; // 45
    // Two spare cards, so neither meld leaves the hand with no legal discard
    // (_rejectIllegalMeldOut would refuse the meld outright, and this test is
    // about the AUDIT, not the close-requirement guard).
    room.playerHands.set('p1', [...kings, ...aces, c('9', 'diamonds'), c('8', 'clubs')]);

    expect(ActionHandlers.handlePlayMeld(room, 'p1', kings).success).to.equal(true);
    expect(room.playerMelds.get('p1'), 'the first meld stands').to.have.length(1);
    expect(ActionHandlers.handlePlayMeld(room, 'p1', aces).success).to.equal(true);

    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(75);
    expect(room.playerMelds.get('p1'), 'both melds stand').to.have.length(2);
    expect(ActionHandlers._applyMinimumMeldRule(room, 'p1').satisfied).to.equal(true);
  });

  it('an UNDO takes the turn\'s credit back with the cards', () => {
    // BAR LAUNDERING: handleUndoMeld returned the cards but left their points in
    // teamMeldPointsThisTurn and the cards themselves in turnMeldedCards. A side
    // could lay 45 + 30, undo one of them, and still have the audit rule the bar
    // MET with 45 points on the table — the requirement spent for the whole
    // round, for free. The stranded turnMeldedCards entry was worse: the next
    // confiscation dealt the SAME card instances into the hand a second time.
    const room = room2();
    room.hasDrawnCard = true;
    ActionHandlers._startTurnForPlayer(room, 'p1');
    const aces = [c('A', 'hearts'), c('A', 'spades'), c('A', 'clubs')]; // 45
    const kings = [c('K', 'hearts'), c('K', 'spades'), c('K', 'clubs')]; // 30
    room.playerHands.set('p1', [...aces, ...kings, c('9', 'diamonds'), c('8', 'clubs')]);

    ActionHandlers.handlePlayMeld(room, 'p1', aces);
    ActionHandlers.handlePlayMeld(room, 'p1', kings);
    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(75);

    expect(ActionHandlers.handleUndoMeld(room, 'p1').success).to.equal(true);

    expect(
      room.teamMeldPointsThisTurn.get('teamA'),
      'the undone 30 is no longer credited'
    ).to.equal(45);
    expect(
      (room.turnMeldedCards.get('p1') || []).length,
      'and the cards are off the confiscation list'
    ).to.equal(3);

    // The bar is NOT met on 45 against 75 — the laundering is closed.
    const verdict = ActionHandlers._applyMinimumMeldRule(room, 'p1');
    expect(verdict.satisfied).to.equal(false);
    expect(room.teamRequiredMeldPoints.get('teamA')).to.equal(95);

    // And no card was dealt twice by the confiscation.
    const ids = room.playerHands.get('p1').map((x) => String(x.cardId));
    expect(new Set(ids).size, 'no duplicate card instances').to.equal(ids.length);
  });

  it('applies in every ruleset, not just professional', () => {
    for (const ruleset of ['classic', 'classicWithNoJoker', 'professional']) {
      const room = room2({ ruleset });
      ActionHandlers._startTurnForPlayer(room, 'p1');
      expect(
        room.teamRequiredMeldPoints.get('teamA'),
        `armed under ${ruleset}`
      ).to.equal(75);
    }
  });
});
