/* eslint-env mocha */

/**
 * MINIMUM MELD counts the BURACO BONUS (product rule, 2026-09-05).
 *
 * Reported from a live table: "meld 2,3,4,5,6,7,8, kan dapet 200 tuh — entah
 * kenapa 200 ini ga masuk hitungan". The bar a side past 1000 owes on its
 * first going-down was measured against CARD POINTS ONLY, so the strongest
 * going-down in the game — a fresh seven-card clean run, 200 bonus — read as
 * 35-55 points, was handed back, and raised the bar. Every bonus counts now:
 * 200 clean, 100 semi/dirty, 2000 for a buraco of 2s. "Ga hanya bonus 200,
 * bonus 100 juga terhitung, intinya bonus ikut terhitung."
 *
 * What counts is what the TURN earned: a bonus that appears this turn (a fresh
 * buraco, or the seventh card onto an older six) — not a bonus the side already
 * held (an eighth card onto a buraco earns its card value and nothing more).
 */
const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const { GameRoom, PlayerSession } = require('../../src/models');
const { Card, Deck } = require('../../src/models/Deck');
const { GameRoomStatus } = require('../../src/constants');

const c = (rank, suit) => new Card(suit, rank);

function room2({ ruleset = 'classic', score = 1000, seats = 2 } = {}) {
  const room = new GameRoom({ roomId: 'min-meld-bonus', maxPlayers: seats });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.ruleset = ruleset;
  room.currentTurn = 0;
  for (let i = 0; i < seats; i += 1) {
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
  const ruleset = room.ruleset || 'classic';
  ActionHandlers._latchMeldGrade(room, playerId, melds.length - 1, cards, ruleset);
  ActionHandlers._trackTurnMeldPoints(room, playerId, cards);
}

/** A meld already on the table from an EARLIER turn: nothing recorded. */
function preExisting(room, playerId, cards) {
  const melds = room.playerMelds.get(playerId) || [];
  melds.push([...cards]);
  room.playerMelds.set(playerId, melds);
  const orders = room.playerMeldOrders.get(playerId) || [];
  orders.push(orders.length + 1);
  room.playerMeldOrders.set(playerId, orders);
  ActionHandlers._latchMeldGrade(room, playerId, melds.length - 1, cards, room.ruleset || 'classic');
  return melds.length - 1;
}

const cardPoints = (room, cards) =>
  cards.reduce((sum, card) => sum + ActionHandlers._cardValue(card, room.ruleset), 0);

const run = (suit, ranks) => ranks.map((r) => c(r, suit));
const CLEAN_7 = ['2', '3', '4', '5', '6', '7', '8'];

describe('#minimum meld counts the buraco bonus', () => {
  it('a fresh 2-3-4-5-6-7-8 is card points + 200, and clears a 75 bar', () => {
    const room = room2();
    ActionHandlers._startTurnForPlayer(room, 'p1');
    const cards = run('hearts', CLEAN_7);
    layDown(room, 'p1', cards);

    const points = cardPoints(room, cards);
    expect(points, 'the cards alone are under the bar').to.be.below(75);
    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(points + 200);

    const verdict = ActionHandlers._applyMinimumMeldRule(room, 'p1');
    expect(verdict.satisfied).to.equal(true);
    expect(verdict.meldPoints).to.equal(points + 200);
    expect(room.playerMelds.get('p1'), 'the meld stands').to.have.length(1);
    expect(room.teamRequiredMeldPoints.get('teamA'), 'the bar is spent').to.equal(0);
  });

  it('the 100 counts too: a DIRTY buraco is card points + 100', () => {
    const room = room2({ ruleset: 'classic' });
    ActionHandlers._startTurnForPlayer(room, 'p1');
    // 4-5-6-[joker as 7]-8-9-10: one substitute plugging a HOLE -> dirty.
    const cards = [
      c('4', 'spades'),
      c('5', 'spades'),
      c('6', 'spades'),
      c('joker', 'joker'),
      c('8', 'spades'),
      c('9', 'spades'),
      c('10', 'spades'),
    ];
    layDown(room, 'p1', cards);
    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(cardPoints(room, cards) + 100);
  });

  it('a SEMI-clean buraco (one wild on the end) pays the 100 like dirty', () => {
    const room = room2({ ruleset: 'classic' });
    ActionHandlers._startTurnForPlayer(room, 'p1');
    const cards = [...run('clubs', ['4', '5', '6', '7', '8', '9']), c('joker', 'joker')];
    layDown(room, 'p1', cards);
    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(cardPoints(room, cards) + 100);
  });

  it('a buraco of 2s counts its 2000', () => {
    const room = room2();
    ActionHandlers._startTurnForPlayer(room, 'p1');
    const cards = [
      c('2', 'hearts'),
      c('2', 'spades'),
      c('2', 'clubs'),
      c('2', 'diamonds'),
      c('2', 'hearts'),
      c('2', 'spades'),
      c('2', 'clubs'),
    ];
    layDown(room, 'p1', cards);
    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(cardPoints(room, cards) + 2000);
  });

  it('the SEVENTH card onto an older six-card meld earns the bonus this turn', () => {
    const room = room2();
    const six = run('diamonds', ['3', '4', '5', '6', '7', '8']);
    const idx = preExisting(room, 'p1', six);
    ActionHandlers._startTurnForPlayer(room, 'p1');
    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(0);

    const ninth = c('9', 'diamonds');
    room.playerMelds.get('p1')[idx].push(ninth);
    ActionHandlers._latchMeldGrade(room, 'p1', idx, room.playerMelds.get('p1')[idx], room.ruleset);
    ActionHandlers._trackTurnMeldPoints(room, 'p1', [ninth]);

    // Only THIS turn's card, plus the bonus the meld just reached.
    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(cardPoints(room, [ninth]) + 200);
    expect(ActionHandlers._applyMinimumMeldRule(room, 'p1').satisfied).to.equal(true);
  });

  it('an EIGHTH card onto a buraco the side already held earns no bonus', () => {
    const room = room2();
    const seven = run('diamonds', ['3', '4', '5', '6', '7', '8', '9']);
    const idx = preExisting(room, 'p1', seven);
    ActionHandlers._startTurnForPlayer(room, 'p1');

    const tenth = c('10', 'diamonds');
    room.playerMelds.get('p1')[idx].push(tenth);
    ActionHandlers._trackTurnMeldPoints(room, 'p1', [tenth]);

    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(cardPoints(room, [tenth]));
    const verdict = ActionHandlers._applyMinimumMeldRule(room, 'p1');
    expect(verdict.satisfied, '10 points against 75 is still short').to.equal(false);
    expect(room.playerMelds.get('p1')[0], 'the older buraco keeps its seven').to.have.length(7);
  });

  it('a wild that DEMOTES a held clean buraco is not a debt on this turn', () => {
    const room = room2({ ruleset: 'classic' });
    const seven = run('spades', ['3', '4', '5', '6', '7', '8', '9']);
    const idx = preExisting(room, 'p1', seven);
    ActionHandlers._startTurnForPlayer(room, 'p1');

    const joker = c('joker', 'joker');
    room.playerMelds.get('p1')[idx].push(joker);
    ActionHandlers._latchMeldGrade(room, 'p1', idx, room.playerMelds.get('p1')[idx], room.ruleset);
    ActionHandlers._trackTurnMeldPoints(room, 'p1', [joker]);

    // 200 -> 100 on the scoreboard, but the turn laid a 30-point card, not −70.
    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(cardPoints(room, [joker]));
  });

  it('two melds in one turn: the bonus of each counts, once', () => {
    const room = room2();
    ActionHandlers._startTurnForPlayer(room, 'p1');
    const a = run('hearts', CLEAN_7);
    const b = run('clubs', ['5', '6', '7', '8', '9', '10', 'J']);
    layDown(room, 'p1', a);
    layDown(room, 'p1', b);
    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(
      cardPoints(room, a) + cardPoints(room, b) + 400
    );
  });

  it('through handlePlayMeld: the wire figure carries the bonus', () => {
    const room = room2();
    room.hasDrawnCard = true;
    room.deck = new Deck();
    room.deck.cards = [c('7', 'clubs')];
    ActionHandlers._startTurnForPlayer(room, 'p1');
    const cards = run('hearts', CLEAN_7);
    // Two spare cards so the meld is not a meld-out.
    room.playerHands.set('p1', [...cards, c('9', 'diamonds'), c('K', 'clubs')]);

    const res = ActionHandlers.handlePlayMeld(room, 'p1', cards);
    expect(res.success, res.error).to.equal(true);

    const points = cardPoints(room, cards) + 200;
    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(points);
    const wire = ActionHandlers.serializeTeamRoundState(room);
    expect(wire.teamMeldPointsThisTurn.teamA).to.equal(points);
    expect(wire.teamRequiredMeldPoints.teamA).to.equal(75);
  });

  it('through handleGoingDown on a seat with NO melds yet', () => {
    // handleGoingDown builds its melds on a fresh `[]` that is not stored in
    // room.playerMelds until after the loop — the per-meld recompute has to run
    // again once it is, or a first going-down prices at card points only.
    const room = room2();
    room.hasDrawnCard = true;
    room.deck = new Deck();
    room.deck.cards = [c('7', 'clubs')];
    ActionHandlers._startTurnForPlayer(room, 'p1');
    const cards = run('hearts', CLEAN_7);
    room.playerHands.set('p1', [...cards, c('9', 'diamonds'), c('K', 'clubs')]);

    const res = ActionHandlers.handleGoingDown(room, 'p1', [cards]);
    expect(res.success, res.error).to.equal(true);
    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(cardPoints(room, cards) + 200);
  });

  it('a fresh buraco MELD-OUT clears the bar on its bonus and the round closes', () => {
    // The mirror image of "the bar is audited on a MELD-OUT close": the same
    // seven-card run that used to be confiscated for reading 50 now reads 250.
    const room = room2();
    room.hasDrawnCard = true;
    room.deck = new Deck();
    room.deck.cards = [c('7', 'clubs')];
    room.deadPiles = [[], []];
    room.playerHasTakenPozzetto.set('p1', true);
    ActionHandlers._startTurnForPlayer(room, 'p1');
    const cards = run('hearts', ['4', '5', '6', '7', '8', '9', '10']);
    room.playerHands.set('p1', [...cards]);

    const res = ActionHandlers.handleGoingDown(room, 'p1', [cards]);
    expect(res.success, res.error).to.equal(true);
    expect(res.broadcast.minimumMeld, 'no refusal').to.equal(undefined);
    expect(room.playerMelds.get('p1'), 'the run stands').to.have.length(1);
    expect(room.teamRequiredMeldPoints.get('teamA'), 'the bar was met').to.equal(0);
  });

  it('an UNDO takes the bonus back with the cards', () => {
    const room = room2();
    room.hasDrawnCard = true;
    ActionHandlers._startTurnForPlayer(room, 'p1');
    const kings = [c('K', 'hearts'), c('K', 'spades'), c('K', 'clubs')]; // 30
    const cards = run('hearts', CLEAN_7);
    room.playerHands.set('p1', [...kings, ...cards, c('9', 'diamonds'), c('8', 'clubs')]);

    expect(ActionHandlers.handlePlayMeld(room, 'p1', kings).success).to.equal(true);
    expect(ActionHandlers.handlePlayMeld(room, 'p1', cards).success).to.equal(true);
    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(30 + cardPoints(room, cards) + 200);

    expect(ActionHandlers.handleUndoMeld(room, 'p1').success).to.equal(true);

    expect(room.teamMeldPointsThisTurn.get('teamA'), 'only the kings remain credited').to.equal(30);
    expect(ActionHandlers._applyMinimumMeldRule(room, 'p1').satisfied).to.equal(false);
  });

  it('an illegal meld-out ROLLBACK leaves neither the points nor the cards on the ledger', () => {
    // Without a brazilia the hand may not empty; the meld is rolled back. The
    // confiscation list has to roll back with it, or the next meld this turn
    // re-counts cards that are back in the hand (and a later confiscation
    // deals them twice).
    const room = room2();
    room.hasDrawnCard = true;
    room.deck = new Deck();
    room.deck.cards = [c('7', 'clubs')];
    ActionHandlers._startTurnForPlayer(room, 'p1');
    const aces = [c('A', 'hearts'), c('A', 'spades'), c('A', 'clubs')]; // 45
    room.playerHands.set('p1', [...aces]);

    const res = ActionHandlers.handlePlayMeld(room, 'p1', aces);
    expect(res.success, 'a hand-emptying meld with no brazilia is refused').to.equal(false);
    expect(room.playerMelds.get('p1')).to.have.length(0);
    expect(room.turnMeldedCards?.get('p1') || []).to.have.length(0);
    expect(room.teamMeldPointsThisTurn.get('teamA') || 0).to.equal(0);
  });

  it('2v2: the partner\'s seventh card onto MY six-card meld counts for the side', () => {
    const room = room2({ seats: 4 });
    const six = run('hearts', ['3', '4', '5', '6', '7', '8']);
    const idx = preExisting(room, 'p1', six);
    // p3 is p1's partner (seats 0 and 2).
    ActionHandlers._startTurnForPlayer(room, 'p3');
    const ninth = c('9', 'hearts');
    room.playerMelds.get('p1')[idx].push(ninth);
    ActionHandlers._latchMeldGrade(room, 'p1', idx, room.playerMelds.get('p1')[idx], room.ruleset);
    ActionHandlers._trackTurnMeldPoints(room, 'p3', [ninth]);

    const teamKey = ActionHandlers._teamKeyForPlayer(room, 'p3');
    expect(room.teamMeldPointsThisTurn.get(teamKey)).to.equal(cardPoints(room, [ninth]) + 200);
  });

  it('_meldBonus is the one ladder _braziliaStats prices the round with', () => {
    const clean = run('hearts', CLEAN_7);
    const dirty = [c('4', 'spades'), c('5', 'spades'), c('6', 'spades'), c('joker', 'joker'), c('8', 'spades'), c('9', 'spades'), c('10', 'spades')];
    const twos = Array.from({ length: 7 }, (_, i) => c('2', ['hearts', 'spades', 'clubs', 'diamonds'][i % 4]));
    const six = run('clubs', ['3', '4', '5', '6', '7', '8']);
    for (const ruleset of ['classic', 'professional']) {
      for (const meld of [clean, dirty, twos, six]) {
        const stats = ActionHandlers._braziliaStats([meld], ruleset, new Map());
        expect(ActionHandlers._meldBonus(meld, ruleset, undefined), `${ruleset}`).to.equal(stats.bonus);
      }
    }
    expect(ActionHandlers._meldBonus(clean, 'classic')).to.equal(200);
    expect(ActionHandlers._meldBonus(dirty, 'classic')).to.equal(100);
    expect(ActionHandlers._meldBonus(twos, 'classic')).to.equal(2000);
    expect(ActionHandlers._meldBonus(six, 'classic')).to.equal(0);
    // A latched grade caps the price, as it does on the scoreboard.
    expect(ActionHandlers._meldBonus(clean, 'classic', 'dirty')).to.equal(100);
  });

  describe('the grade latch follows the cards back', () => {
    // A latch records how a buraco was BUILT (downgrade-only, from the 7th
    // card). An add that is undone or confiscated was never built — but the
    // latch used to stay, so a joker laid as the 7th and handed straight back
    // branded six naturals 'semi' forever: the next natural 7th then earned 100
    // for the bar (now that the bar reads the bonus) AND on the scoreboard.
    const latchOf = (room, playerId, idx) =>
      ActionHandlers._latchedGrade(room.meldDirtyFlags.get(playerId), idx);

    it('a wild added then UNDONE leaves no latch: the natural 7th still earns 200', () => {
      const room = room2({ ruleset: 'classic' });
      room.hasDrawnCard = true;
      const idx = preExisting(room, 'p1', run('hearts', ['3', '4', '5', '6', '7', '8']));
      ActionHandlers._startTurnForPlayer(room, 'p1');
      const joker = c('joker', 'joker');
      const nine = c('9', 'hearts');
      room.playerHands.set('p1', [joker, nine, c('K', 'clubs'), c('Q', 'diamonds')]);

      const added = ActionHandlers.handleAddToMeld(room, 'p1', [joker], 0, idx);
      expect(added.success, added.error).to.equal(true);
      expect(latchOf(room, 'p1', idx), 'a joker on the end of six naturals latches').to.not.equal(undefined);
      expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(cardPoints(room, [joker]) + 100);

      expect(ActionHandlers.handleUndoMeld(room, 'p1').success).to.equal(true);
      expect(latchOf(room, 'p1', idx), 'the undo takes the latch back too').to.equal(undefined);
      expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(0);

      const natural = ActionHandlers.handleAddToMeld(room, 'p1', [nine], 0, idx);
      expect(natural.success, natural.error).to.equal(true);
      expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(cardPoints(room, [nine]) + 200);
      expect(
        ActionHandlers._braziliaStats(room.playerMelds.get('p1'), room.ruleset, room.meldDirtyFlags.get('p1')).bonus,
        'and the scoreboard agrees'
      ).to.equal(200);
    });

    it('a wild 7th CONFISCATED by the audit leaves the six unlatched', () => {
      const room = room2({ ruleset: 'classic' });
      room.hasDrawnCard = true;
      const idx = preExisting(room, 'p1', run('hearts', ['3', '4', '5', '6', '7', '8']));
      ActionHandlers._startTurnForPlayer(room, 'p1');
      // Two earlier misses: the bar stands at 200, which 30 + 100 cannot clear.
      room.teamRequiredMeldPoints.set('teamA', 200);
      const joker = c('joker', 'joker');
      room.playerHands.set('p1', [joker, c('K', 'clubs'), c('Q', 'diamonds')]);
      expect(ActionHandlers.handleAddToMeld(room, 'p1', [joker], 0, idx).success).to.equal(true);

      const verdict = ActionHandlers._applyMinimumMeldRule(room, 'p1');
      expect(verdict.satisfied).to.equal(false);
      expect(room.playerMelds.get('p1')[idx], 'the six survive').to.have.length(6);
      expect(latchOf(room, 'p1', idx), 'with no latch').to.equal(undefined);

      // A later turn: the natural 9 completes a CLEAN buraco.
      ActionHandlers._startTurnForPlayer(room, 'p1');
      const nine = c('9', 'hearts');
      room.playerHands.set('p1', [nine, c('K', 'clubs'), c('Q', 'diamonds')]);
      expect(ActionHandlers.handleAddToMeld(room, 'p1', [nine], 0, idx).success).to.equal(true);
      expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(cardPoints(room, [nine]) + 200);
      expect(
        ActionHandlers._braziliaStats(room.playerMelds.get('p1'), room.ruleset, room.meldDirtyFlags.get('p1')).bonus
      ).to.equal(200);
    });

    it('a held CLEAN buraco demoted by a confiscated wild is clean again', () => {
      const room = room2({ ruleset: 'classic' });
      room.hasDrawnCard = true;
      const idx = preExisting(room, 'p1', run('spades', ['3', '4', '5', '6', '7', '8', '9']));
      ActionHandlers._startTurnForPlayer(room, 'p1');
      room.teamRequiredMeldPoints.set('teamA', 200);
      const joker = c('joker', 'joker');
      room.playerHands.set('p1', [joker, c('K', 'clubs'), c('Q', 'diamonds')]);
      expect(ActionHandlers.handleAddToMeld(room, 'p1', [joker], 0, idx).success).to.equal(true);
      expect(latchOf(room, 'p1', idx)).to.not.equal(undefined);

      expect(ActionHandlers._applyMinimumMeldRule(room, 'p1').satisfied).to.equal(false);

      expect(room.playerMelds.get('p1')[idx]).to.have.length(7);
      expect(latchOf(room, 'p1', idx), 'the pre-turn latch (none) is back').to.equal(undefined);
      expect(
        ActionHandlers._braziliaStats(room.playerMelds.get('p1'), room.ruleset, room.meldDirtyFlags.get('p1')).bonus
      ).to.equal(200);
    });

    it('a held DIRTY buraco keeps its latch through a confiscation', () => {
      // The restore puts back the PRE-TURN latch, not a blank one.
      const room = room2({ ruleset: 'classic' });
      room.hasDrawnCard = true;
      const idx = preExisting(room, 'p1', run('spades', ['3', '4', '5', '6', '7', '8', '9']));
      ActionHandlers._setLatch(room, 'p1', idx, 'dirty');
      ActionHandlers._startTurnForPlayer(room, 'p1');
      room.teamRequiredMeldPoints.set('teamA', 200);
      const ten = c('10', 'spades');
      room.playerHands.set('p1', [ten, c('K', 'clubs'), c('Q', 'diamonds')]);
      expect(ActionHandlers.handleAddToMeld(room, 'p1', [ten], 0, idx).success).to.equal(true);

      expect(ActionHandlers._applyMinimumMeldRule(room, 'p1').satisfied).to.equal(false);

      expect(room.playerMelds.get('p1')[idx]).to.have.length(7);
      expect(latchOf(room, 'p1', idx)).to.equal('dirty');
    });
  });
});
