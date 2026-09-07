/**
 * "200 bisa jadi 100, tapi 100 gabisa jadi 200 (sekarang soalnya bisa)"
 * — 2026-08-28, with three worked examples.
 *
 * A buraco's grade is a fact about HOW IT WAS BUILT, and cards that arrive
 * afterwards cannot rebuild it. The ratchet only ever turns one way.
 *
 * REFINED 2026-09-03: one way, but only once there is a bonus to protect — a
 * grade exists only from the SEVENTH card (ActionHandlers._latchMeldGrade).
 * Latching from the first card branded 8-7-6-5-4-3-2 DIRTY with no wild in
 * sight ("harusnya +200"). THE REPORT below is re-read under that rule; the
 * seven-card cases are unchanged.
 *
 * It was already there, and it was gated `ruleset === 'professional'` in all
 * three places that matter: the two writes that record the flag, and the read
 * that honours it. So in CLASSIC — the ruleset these tables actually run — the
 * flag was never written and never read, and a dirty buraco was re-graded CLEAN
 * by the very reorder that puts a wild-2 back on its own rank.
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

function room(ruleset) {
  const r = new GameRoom({ roomId: `grade-${ruleset}`, maxPlayers: 2 });
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
    r.meldDirtyFlags.set(id, new Set());
  }
  return r;
}

/** Grade of p1's meld 0 exactly as the wire reports it. */
const graded = (r) =>
  GameValidator.meldClean(
    r.playerMelds.get('p1')[0],
    r.ruleset,
    (r.meldDirtyFlags.get('p1') || new Set()).has(0)
  );

const ranks = (r) => r.playerMelds.get('p1')[0].map((x) => x.rank).join(' ');

for (const ruleset of ['classic', 'professional']) {
  describe(`#a buraco's grade never improves (${ruleset})`, () => {
    it('THE REPORT, re-read 2026-09-03: six cards with a filler 2 carry no grade yet, and the 3 makes it CLEAN', () => {
      const r = room(ruleset);
      // 4-5-6-7-8 with a 2 standing in for the 9. On 2026-08-28 this latched
      // DIRTY from the first card ("how it was built"); since 2026-09-03 a
      // grade exists only for a BURACO, so six cards latch nothing and the
      // meld is read for the first time on the layout the seventh card lands
      // in. Same INSTANCES throughout: the handlers resolve a card out of the
      // hand by identity, so a freshly built Card is simply not found.
      const seq = ['4', '5', '6', '7', '8', '2'].map((x) => c('diamonds', x));
      const three = c('diamonds', '3');
      r.playerHands.set('p1', [...seq, three, c('clubs', 'K')]);

      ActionHandlers.handlePlayMeld(r, 'p1', seq);
      expect(graded(r), 'the CARDS read dirty while the 2 fills the 9').to.equal(false);
      expect(
        ActionHandlers._gradeFlags(r.meldDirtyFlags.get('p1')).has(0),
        'but nothing is latched below seven cards'
      ).to.equal(false);

      // The 3 arrives. The 2 slides back to rank two, the run reads clean, and
      // THIS is the layout the grade is born on.
      ActionHandlers.handleAddToMeld(r, 'p1', three, 0, 0);

      expect(ranks(r), 'item 3: the order must be right').to.equal('2 3 4 5 6 7 8');
      expect(graded(r), 'a natural 2 at the seventh card is CLEAN — 200').to.equal(true);
    });

    it('a buraco BORN with a filler stays below clean, even when the filler slides home', () => {
      const r = room(ruleset);
      // 4-5-6-7-8-9 with a 2 on the end: SEVEN cards, so the grade is read
      // now — semi in classic (end wild), dirty in professional.
      const seq = ['4', '5', '6', '7', '8', '9', '2'].map((x) => c('diamonds', x));
      const three = c('diamonds', '3');
      r.playerHands.set('p1', [...seq, three, c('clubs', 'K'), c('hearts', 'Q')]);

      ActionHandlers.handlePlayMeld(r, 'p1', seq);
      expect(graded(r), 'a filler 2 at seven cards is not clean').to.equal(false);

      // The 3 arrives and the 2 slides home. The cards read clean; the grade
      // was born below clean and stays there — 100 cannot become 200.
      ActionHandlers.handleAddToMeld(r, 'p1', three, 0, 0);
      expect(ranks(r)).to.equal('2 3 4 5 6 7 8 9');
      expect(graded(r), 'born below clean, so it stays there').to.equal(false);
    });

    it('a clean buraco that GOES dirty stays dirty once the gap is filled', () => {
      const r = room(ruleset);
      // 2-3-4-5-6-7-8 all diamonds: the 2 is natural, so this is clean.
      const seq = ['2', '3', '4', '5', '6', '7', '8'].map((x) => c('diamonds', x));
      const ten = c('diamonds', '10');
      const nine = c('diamonds', '9');
      r.playerHands.set('p1', [...seq, ten, nine, c('clubs', 'K')]);

      ActionHandlers.handlePlayMeld(r, 'p1', seq);
      expect(graded(r), 'every card natural').to.equal(true);

      // The 10 arrives: the 2 can no longer be natural, it becomes the 9.
      ActionHandlers.handleAddToMeld(r, 'p1', ten, 0, 0);
      expect(graded(r), '200 -> 100 is allowed').to.equal(false);

      // The real 9 arrives. The order is right again — the grade is not.
      ActionHandlers.handleAddToMeld(r, 'p1', nine, 0, 0);
      expect(
        graded(r),
        '"karna sempat 100, dia ga boleh ganti jadi 200 lagi"'
      ).to.equal(false);
    });

    it('the BADGE and the SCORE agree on every meld', () => {
      // The server used to carry TWO natural-two predicates: a strict/gapless
      // copy on ActionHandlers (which fed _isCleanMeld / _isDirtyMeld /
      // _isSemiCleanSequence and therefore _computeScores) and the filler-aware
      // one on GameValidator (which fed meldClean and therefore the per-meld
      // `clean` badge on the wire). One frame could carry `clean: true` next to
      // a buracoDirtyCount that had counted the same meld as dirty — and the
      // Flutter client mirrors only the filler-aware definition, so it agreed
      // with the badge and not with the score.
      const r = room(ruleset);
      // 2♦ in its own slot, with a gap at the 8 that the joker already plugs.
      // The strict copy called the 2 a WILD purely because of that gap.
      const seq = [
        c('diamonds', '2'),
        c('diamonds', '3'),
        c('diamonds', '4'),
        c('diamonds', '5'),
        c('diamonds', '6'),
        c('diamonds', '7'),
        ruleset === 'professional' ? c('diamonds', '8') : c('joker', 'joker'),
        c('diamonds', '9'),
      ];
      r.playerHands.set('p1', [...seq, c('clubs', 'K')]);
      ActionHandlers.handlePlayMeld(r, 'p1', seq);

      const meld = r.playerMelds.get('p1')[0];
      const sticky = (r.meldDirtyFlags.get('p1') || new Set()).has(0);
      expect(
        ActionHandlers._isNaturalTwo(meld.find((x) => x.rank === '2'), meld),
        'the scoring path and the badge path answer the same question'
      ).to.equal(GameValidator._isNaturalTwo(meld.find((x) => x.rank === '2'), meld));
      expect(ActionHandlers._isCleanMeld(meld, r.ruleset, sticky)).to.equal(graded(r));
    });

    it('a sticky-dirty meld is never graded SEMI-CLEAN either', () => {
      // The sticky flag was consulted for `clean` and then IGNORED one line
      // later: `isSemiClean` was computed from the cards alone. So a buraco
      // latched dirty whose cards had since come to read semi-clean — six
      // consecutive naturals with a single wild on the end — was counted
      // semiClean, a grade BETTER than dirty, which is exactly what the ratchet
      // exists to refuse. The Flutter client returns dirty before it ever
      // reaches its semi-clean branch, so the two engines disagreed on the
      // buracoSemiCleanCount / buracoDirtyCount the round board prints.
      if (ruleset === 'professional') return; // semi-clean is a classic grade
      const meld = [
        c('spades', '4'),
        c('spades', '5'),
        c('spades', '6'),
        c('spades', '7'),
        c('spades', '8'),
        c('spades', '9'),
        c('joker', 'joker'),
      ];
      expect(
        ActionHandlers._isSemiCleanSequence(meld),
        'the CARDS do read semi-clean'
      ).to.equal(true);

      const fresh = ActionHandlers._braziliaStats([meld], ruleset, new Set());
      expect(fresh.semiClean, 'and a meld that was never dirty is graded so').to.equal(1);

      const latched = ActionHandlers._braziliaStats([meld], ruleset, new Set([0]));
      expect(latched.clean, 'not clean').to.equal(0);
      expect(latched.semiClean, 'and not semi-clean either').to.equal(0);
      expect(latched.dirty, 'it stays dirty').to.equal(1);
      expect(latched.bonus, 'the bonus is the same 100 either way (today)').to.equal(
        fresh.bonus
      );
    });

    it('a buraco that was never dirty is left alone', () => {
      const r = room(ruleset);
      const seq = ['3', '4', '5', '6', '7', '8', '9'].map((x) => c('diamonds', x));
      const ten = c('diamonds', '10');
      r.playerHands.set('p1', [...seq, ten, c('clubs', 'K')]);

      ActionHandlers.handlePlayMeld(r, 'p1', seq);
      ActionHandlers.handleAddToMeld(r, 'p1', ten, 0, 0);

      expect(graded(r), 'nothing here was ever wild').to.equal(true);
    });
  });
}
