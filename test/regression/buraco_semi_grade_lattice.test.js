/**
 * The grade LATTICE: clean > semi-clean > dirty, downgrade-only.
 *
 * The ratchet ("100 gabisa jadi 200") used to be recorded as one bit whose
 * predicate was _isDirtyMeld — true for ANY substitute wild, the single
 * end-wild shape included. So a semi-clean buraco was branded dirty the moment
 * it was laid and the semiClean grade was unreachable on a live table: the
 * score board printed DIRTY under a ladder whose one wild sat politely on the
 * end. Reported live from the offline score-details board ("Kok gini sih").
 *
 * The latch now records the WORST GRADE a meld has ever held
 * (room.meldDirtyFlags: index -> 'semi' | 'dirty). The price is unchanged —
 * semi and dirty both pay BURACO_BONUS, and any latch bars CLEAN's 200
 * forever. Only the LABEL was wrong, and labels are what players read.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const GameValidator = require('../../src/validators/GameValidator');
const { GameRoom } = require('../../src/models');
const PlayerSession = require('../../src/models/PlayerSession');
const { GameRoomStatus } = require('../../src/constants');
const { Card } = require('../../src/models/Deck');

const c = (suit, rank) => new Card(suit, rank);

function room(ruleset = 'classic') {
  const r = new GameRoom({ roomId: `lattice-${ruleset}`, maxPlayers: 2 });
  r.status = GameRoomStatus.IN_PROGRESS;
  r.ruleset = ruleset;
  r.currentTurn = 0;
  r.hasDrawnCard = true;
  for (let i = 0; i < 2; i += 1) {
    const id = `p${i + 1}`;
    r.addPlayer(
      new PlayerSession({ playerId: id, playerName: id, playerIndex: i, socketId: `s${i + 1}` })
    );
    r.playerHands.set(id, []);
    r.playerMelds.set(id, []);
    r.playerHasTakenPozzetto.set(id, false);
    r.playerDeadPileCount.set(id, 0);
    r.meldDirtyFlags.set(id, new Map());
  }
  return r;
}

const latchOf = (r, idx = 0) => r.meldDirtyFlags.get('p1').get(idx);
const statsOf = (r) =>
  ActionHandlers._braziliaStats(
    r.playerMelds.get('p1'),
    r.ruleset,
    r.meldDirtyFlags.get('p1')
  );
const wireOf = (r, idx = 0) =>
  ActionHandlers._meldFlags(r, 'p1', r.playerMelds.get('p1')[idx], idx);

describe('#the grade lattice: semi-clean is a real grade, not a spelling of dirty', () => {
  it('THE SCREENSHOT: an end-wild ladder is SEMI at creation, not dirty', () => {
    const r = room();
    // 4♠..9♠ with the 2♠ standing in for the 3: one substitute, on the end.
    const seq = ['4', '5', '6', '7', '8', '9', '2'].map((x) => c('spades', x));
    r.playerHands.set('p1', [...seq, c('hearts', 'K')]);

    ActionHandlers.handlePlayMeld(r, 'p1', seq);

    expect(latchOf(r), 'latched at its own grade').to.equal('semi');
    const stats = statsOf(r);
    expect(stats.semiClean, 'counted as semi-clean').to.equal(1);
    expect(stats.dirty, 'NOT as dirty').to.equal(0);
    expect(stats.bonus, 'semi pays the 100 figure').to.equal(ActionHandlers.BURACO_BONUS);
    const wire = wireOf(r);
    expect(wire.clean).to.equal(false);
    expect(wire.grade, 'the wire says WHICH not-clean').to.equal('semi');
  });

  it('adding the real 3 keeps it SEMI — never clean, never 200', () => {
    const r = room();
    const seq = ['4', '5', '6', '7', '8', '9', '2'].map((x) => c('spades', x));
    const three = c('spades', '3');
    r.playerHands.set('p1', [...seq, three, c('hearts', 'K')]);
    ActionHandlers.handlePlayMeld(r, 'p1', seq);

    ActionHandlers.handleAddToMeld(r, 'p1', three, 0, 0);

    expect(latchOf(r), 'the latch survives the heal').to.equal('semi');
    const stats = statsOf(r);
    expect(stats.semiClean).to.equal(1);
    expect(stats.clean, 'cards read clean; the grade does not').to.equal(0);
    expect(stats.bonus, '100 gabisa jadi 200').to.equal(ActionHandlers.BURACO_BONUS);
    expect(wireOf(r).grade).to.equal('semi');
  });

  it('an INTERIOR wild is dirty, and stays dirty after the gap is filled', () => {
    const r = room();
    // 4..6, 8..10 with the 2 plugging the 7: a hole, not an end.
    const seq = ['4', '5', '6', '8', '9', '10', '2'].map((x) => c('clubs', x));
    const seven = c('clubs', '7');
    r.playerHands.set('p1', [...seq, seven, c('hearts', 'K')]);
    ActionHandlers.handlePlayMeld(r, 'p1', seq);
    expect(latchOf(r)).to.equal('dirty');

    ActionHandlers.handleAddToMeld(r, 'p1', seven, 0, 0);

    expect(latchOf(r)).to.equal('dirty');
    const stats = statsOf(r);
    expect(stats.dirty).to.equal(1);
    expect(stats.semiClean).to.equal(0);
    expect(wireOf(r).grade).to.equal('dirty');
  });

  it('a SEMI can still fall to DIRTY — the lattice only ever descends', () => {
    const r = room();
    // 4-5-6-7-8-9 + 2 on the end (as the 10): SEVEN cards, so a grade exists
    // (2026-09-03: nothing latches below a buraco), and it is semi.
    const seq = ['4', '5', '6', '7', '8', '9', '2'].map((x) => c('diamonds', x));
    const jack = c('diamonds', 'J');
    // Two spare cards: the meld-shed guard refuses an add that would leave
    // the hand un-discardable, and that guard is not what is under test here.
    r.playerHands.set('p1', [...seq, jack, c('hearts', 'K'), c('hearts', '9')]);
    ActionHandlers.handlePlayMeld(r, 'p1', seq);
    expect(latchOf(r)).to.equal('semi');

    // The J arrives: naturals 4..9 + J leave a hole at the 10 and the wild
    // falls into it.
    const added = ActionHandlers.handleAddToMeld(r, 'p1', jack, 0, 0);
    expect(added.success, added.error).to.equal(true);

    expect(latchOf(r), 'semi -> dirty is allowed').to.equal('dirty');
  });

  it('a natural ladder never latches and still pays CLEAN', () => {
    const r = room();
    const seq = ['3', '4', '5', '6', '7', '8', '9'].map((x) => c('spades', x));
    const two = c('spades', '2');
    r.playerHands.set('p1', [...seq, two, c('hearts', 'K')]);
    ActionHandlers.handlePlayMeld(r, 'p1', seq);
    // The natural 2 lands on its own rank: no substitute, nothing to latch.
    ActionHandlers.handleAddToMeld(r, 'p1', two, 0, 0);

    expect(latchOf(r)).to.equal(undefined);
    const stats = statsOf(r);
    expect(stats.clean).to.equal(1);
    expect(stats.bonus).to.equal(ActionHandlers.CLEAN_BURACO_BONUS);
    expect(wireOf(r)).to.deep.include({ clean: true, grade: 'clean' });
  });

  it('professional has no semi grade: its one substitute latches DIRTY', () => {
    const r = room('professional');
    const seq = ['4', '5', '6', '7', '8', '9', '2'].map((x) => c('spades', x));
    r.playerHands.set('p1', [...seq, c('hearts', 'K')]);
    ActionHandlers.handlePlayMeld(r, 'p1', seq);

    expect(latchOf(r)).to.equal('dirty');
    const stats = statsOf(r);
    expect(stats.dirty).to.equal(1);
    expect(stats.semiClean).to.equal(0);
  });

  it('a legacy Set container still reads as dirty (old snapshots)', () => {
    const meld = ['4', '5', '6', '7', '8', '9', '2'].map((x) => c('spades', x));
    const stats = ActionHandlers._braziliaStats([meld], 'classic', new Set([0]));
    expect(stats.dirty, 'membership meant dirty in the Set era').to.equal(1);
    expect(stats.semiClean).to.equal(0);
    expect(stats.bonus).to.equal(ActionHandlers.BURACO_BONUS);
  });

  it('serializeMelds carries the grade for every seat', () => {
    const r = room();
    const seq = ['4', '5', '6', '7', '8', '9', '2'].map((x) => c('spades', x));
    r.playerHands.set('p1', [...seq, c('hearts', 'K')]);
    ActionHandlers.handlePlayMeld(r, 'p1', seq);

    const seat = r.serializeMelds().find((s) => s.playerIndex === 0);
    expect(seat.melds[0].clean).to.equal(false);
    expect(seat.melds[0].grade).to.equal('semi');
  });

  it('the royal count belongs to the CLEAN ladder alone', () => {
    const ladder = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].map((x) =>
      c('hearts', x)
    );
    const clean = ActionHandlers._braziliaStats([ladder], 'classic', new Map());
    expect(clean.royal).to.equal(1);
    expect(clean.clean).to.equal(1);
    // The same cards under a latch: the celebration is off, the price is 100.
    const latched = ActionHandlers._braziliaStats([ladder], 'classic', new Map([[0, 'semi']]));
    expect(latched.royal).to.equal(0);
    expect(latched.semiClean).to.equal(1);
    expect(latched.bonus).to.equal(ActionHandlers.BURACO_BONUS);
  });

  it('Q-K-A plus one end wild is SEMI in the high orientation too', () => {
    // The old single-orientation read (ace low only) called this dirty.
    const meld = ['9', '10', 'J', 'Q', 'K', 'A', '2'].map((x) => c('clubs', x));
    expect(GameValidator.meldCardGrade(meld, 'classic')).to.equal('semi');
  });
});
