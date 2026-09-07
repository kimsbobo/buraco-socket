// THE GRADED BURACO LADDER — socket side, in the product owner's own scenarios.
//
// Stated 2026-09-02:
//   clean (no substitute wild) -> 200
//   semi-clean / dirty         -> 100
//   buraco of 2s               -> 2000
//   the grade may DROP, never RISE.
//
// A 2 sitting in its OWN place (2-3-4-5-6-7-8) is a natural 2, not a wild, so
// that buraco is clean. Move it to cover a gap (4-5-[2]-7-8-9-10) and it is a
// substitute, so the buraco is dirty.
//
// This is a GENERAL rule: it must read identically here and in the Flutter
// engine. The client mirror is buraco_sdk/test/buraco_bonus_ladder_test.dart —
// the two files carry the SAME scenarios on purpose, because a divergence here
// is a divergence a player sees between an online table and a vs-bot one.
const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');

const c = (suit, rank, cardId) => ({ suit, rank, cardId });
const run = (suit, ranks, base) => ranks.map((r, i) => c(suit, r, base + i));

// _braziliaStats(melds, ruleset, dirtySet) is the one place the bonus is
// priced, so it is what these assert against.
const stats = (melds, { ruleset = 'professional', dirty = null } = {}) =>
  ActionHandlers._braziliaStats(melds, ruleset, dirty);

describe('#buraco bonus ladder (2026-09-02)', () => {
  describe("the owner's worked example", () => {
    it('2-3-4-5-6-7-8: the 2 is in its OWN place, so clean -> 200', () => {
      const meld = run('hearts', ['2', '3', '4', '5', '6', '7', '8'], 10);
      const s = stats([meld]);
      expect(s.clean).to.equal(1);
      expect(s.dirty).to.equal(0);
      expect(s.bonus).to.equal(200);
    });

    it('4-5-[2]-7-8-9-10: the 2 stands in for the 6, so dirty -> 100', () => {
      const meld = run('hearts', ['4', '5', '2', '7', '8', '9', '10'], 20);
      const s = stats([meld]);
      expect(s.dirty).to.equal(1);
      expect(s.clean).to.equal(0);
      expect(s.bonus).to.equal(100);
    });
  });

  describe('the ratchet — a grade may drop but never climb back', () => {
    it('the cards alone would read clean, but a latched buraco stays 100', () => {
      // 2-3-4-5-6-7-8-9-10 with the 2 back at the bottom. On its cards this is
      // clean; the sticky flag is what refuses to pay the 200 back.
      const meld = run(
        'hearts',
        ['2', '3', '4', '5', '6', '7', '8', '9', '10'],
        30
      );

      const fresh = stats([meld]);
      expect(fresh.clean, 'sanity: on the cards alone this shape IS clean')
        .to.equal(1);
      expect(fresh.bonus).to.equal(200);

      const latched = stats([meld], { dirty: new Set([0]) });
      expect(latched.dirty).to.equal(1);
      expect(latched.clean).to.equal(0);
      expect(latched.bonus, 'the bonus climbed back from 100 to 200')
        .to.equal(100);
    });

    it('dropping is allowed: the same run plus a substitute 2 pays 100', () => {
      const clean = run('hearts', ['3', '4', '5', '6', '7', '8', '9'], 40);
      expect(stats([clean]).bonus).to.equal(200);

      const dented = [...clean, c('spades', '2', 49)];
      expect(stats([dented]).bonus).to.equal(100);
    });
  });

  describe('the rest of the ladder', () => {
    it('a buraco of 2s still pays 2000, ahead of clean/dirty', () => {
      const meld = ['hearts', 'spades', 'clubs', 'diamonds', 'hearts', 'spades', 'clubs']
        .map((suit, i) => c(suit, '2', 50 + i));
      const s = stats([meld]);
      expect(s.twos).to.equal(1);
      expect(s.bonus).to.equal(2000);
    });

    it('a royal run is clean, and clean is all it needs to reach 200', () => {
      const meld = run(
        'hearts',
        ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'],
        60
      );
      const s = stats([meld]);
      expect(s.royal, 'royal is still COUNTED').to.equal(1);
      expect(s.bonus, 'it is just no longer a separate PRICE').to.equal(200);
    });

    it('CLASSIC semi-clean pays the dirty figure, and is still counted', () => {
      // Exactly one wild, tacked on the END rather than plugging a hole.
      const meld = [
        ...run('hearts', ['3', '4', '5', '6', '7', '8'], 80),
        c('spades', '2', 89),
      ];
      const s = stats([meld], { ruleset: 'classic' });
      expect(s.semiClean).to.equal(1);
      expect(s.bonus).to.equal(100);
    });

    it('a six-card run is not a buraco and earns no bonus at all', () => {
      const meld = run('hearts', ['3', '4', '5', '6', '7', '8'], 90);
      const s = stats([meld]);
      expect(s.bonus).to.equal(0);
      expect(s.clean).to.equal(0);
    });
  });
});
