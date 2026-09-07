/**
 * A GRADE EXISTS ONLY FOR A BURACO — the ratchet starts at the seventh card.
 *
 * Product decision 2026-09-03, from a score-details screenshot: 9♠..2♠ and
 * 8♣..2♣ printed DIRTY +100 with no wild in sight ("harusnya yang pertama dan
 * ke3 +200"). They had been built with the 2 as a filler at some step — 4-5-6,
 * then the 2 standing in for the 3, then the real 3 — and the 2026-08-28 latch
 * graded a meld "on how it was built" from its FIRST card. The user's rule is
 * "angka bonus gaboleh naik": there is no bonus figure to protect before the
 * seventh card, so nothing latches before it (_latchMeldGrade). From the
 * seventh card on the grade may fall and never climb — that half is unchanged,
 * see buraco_grade_never_improves.test.js.
 *
 * The last block is the oracle: EVERY single-add build order of the
 * screenshot's clubs run, checked against "the worst card-grade the meld held
 * at any step where it was already a buraco". Client mirror:
 * buraco_sdk/test/buraco_ratchet_starts_at_seven_test.dart.
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
  const r = new GameRoom({ roomId: `seven-${ruleset}`, maxPlayers: 2 });
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

/** Three spare cards so the meld-shed guard never refuses a lay. */
const spares = () => [c('hearts', 'K'), c('hearts', 'Q'), c('hearts', 'J')];

const meldOf = (r) => r.playerMelds.get('p1')[0];
const latchOf = (r) => ActionHandlers._gradeFlags(r.meldDirtyFlags.get('p1')).get(0);
const statsOf = (r) =>
  ActionHandlers._braziliaStats(r.playerMelds.get('p1'), r.ruleset, r.meldDirtyFlags.get('p1'));
const wireOf = (r) => ActionHandlers._meldFlags(r, 'p1', meldOf(r), 0);

const ok = (res, what) => {
  expect(res && res.success !== false, `${what}: ${res && res.error}`).to.equal(true);
};

for (const ruleset of ['classic', 'professional']) {
  describe(`#the ratchet starts at seven — the screenshot, rebuilt (${ruleset})`, () => {
    it('8♣..2♣: 4-5-6, then the 2 as the 3, then the real 3 — CLEAN 200', () => {
      const r = room(ruleset);
      const four = c('clubs', '4');
      const five = c('clubs', '5');
      const six = c('clubs', '6');
      const two = c('clubs', '2');
      const three = c('clubs', '3');
      const seven = c('clubs', '7');
      const eight = c('clubs', '8');
      r.playerHands.set('p1', [four, five, six, two, three, seven, eight, ...spares()]);

      ok(ActionHandlers.handlePlayMeld(r, 'p1', [four, five, six]), 'lay 4-5-6');

      // The 2 lands on 4-5-6 with no 3 in sight: the server can only read it
      // as a filler. Four cards — nothing to latch.
      ok(ActionHandlers.handleAddToMeld(r, 'p1', two, 0, 0), 'add the 2');
      expect(GameValidator.meldCardGrade(meldOf(r), ruleset), 'sanity: a filler').to.not.equal('clean');
      expect(latchOf(r), 'no grade below seven cards').to.equal(undefined);

      ok(ActionHandlers.handleAddToMeld(r, 'p1', three, 0, 0), 'add the 3'); // the 2 slides home
      ok(ActionHandlers.handleAddToMeld(r, 'p1', seven, 0, 0), 'add the 7');
      ok(ActionHandlers.handleAddToMeld(r, 'p1', eight, 0, 0), 'add the 8'); // seventh: read NOW

      expect(meldOf(r)).to.have.length(7);
      expect(latchOf(r)).to.equal(undefined);
      const stats = statsOf(r);
      expect(stats.clean, 'graded clean').to.equal(1);
      expect(stats.bonus, 'harusnya +200').to.equal(ActionHandlers.CLEAN_BURACO_BONUS);
      expect(wireOf(r).clean).to.equal(true);
      expect(wireOf(r).grade).to.equal('clean');
    });

    it('9♠..2♠: 5-6-7, the 2 as a filler, then 4, 3, 8, 9 — CLEAN 200', () => {
      const r = room(ruleset);
      const s = {};
      for (const x of ['2', '3', '4', '5', '6', '7', '8', '9']) s[x] = c('spades', x);
      r.playerHands.set('p1', [...Object.values(s), ...spares()]);

      ok(ActionHandlers.handlePlayMeld(r, 'p1', [s['5'], s['6'], s['7']]), 'lay 5-6-7');
      for (const x of ['2', '4', '3', '8', '9']) {
        ok(ActionHandlers.handleAddToMeld(r, 'p1', s[x], 0, 0), `add the ${x}`);
      }

      expect(meldOf(r)).to.have.length(8);
      expect(latchOf(r)).to.equal(undefined);
      expect(statsOf(r).bonus).to.equal(ActionHandlers.CLEAN_BURACO_BONUS);
      expect(wireOf(r).grade).to.equal('clean');
    });

    it('the SAME run built so the filler is still filling at seven pays 100, and keeps paying 100 after the heal', () => {
      const r = room(ruleset);
      const s = {};
      for (const x of ['2', '3', '4', '5', '6', '7', '8', '9']) s[x] = c('spades', x);
      r.playerHands.set('p1', [...Object.values(s), ...spares()]);

      ok(
        ActionHandlers.handlePlayMeld(r, 'p1', ['4', '5', '6', '7', '8', '9'].map((x) => s[x])),
        'lay 4..9'
      );
      expect(latchOf(r), 'six naturals, nothing yet').to.equal(undefined);

      // The 2 arrives on six naturals: seven cards with a filler — the grade
      // is born below clean.
      ok(ActionHandlers.handleAddToMeld(r, 'p1', s['2'], 0, 0), 'add the 2');
      expect(latchOf(r), 'a filler at seven latches').to.not.equal(undefined);
      expect(statsOf(r).bonus).to.equal(ActionHandlers.BURACO_BONUS);

      // The real 3 arrives and the 2 goes home. The grade does not follow.
      ok(ActionHandlers.handleAddToMeld(r, 'p1', s['3'], 0, 0), 'add the 3');
      expect(GameValidator.meldCardGrade(meldOf(r), ruleset), 'sanity: cards read clean').to.equal('clean');
      expect(statsOf(r).bonus, '100 gabisa jadi 200').to.equal(ActionHandlers.BURACO_BONUS);
      expect(wireOf(r).clean).to.equal(false);
    });
  });

  describe(`#the oracle — every single-add build order of 2♣..8♣ (${ruleset})`, () => {
    const worse = (a, b) => {
      if (a === 'dirty' || b === 'dirty') return 'dirty';
      if (a === 'semi' || b === 'semi') return 'semi';
      return undefined;
    };

    /** Lays order[0..k) then adds the rest one at a time; null if refused. */
    const replay = (order, k) => {
      const r = room(ruleset);
      r.playerHands.set('p1', [...order, ...spares()]);
      let res = ActionHandlers.handlePlayMeld(r, 'p1', order.slice(0, k));
      if (!res || res.success === false) return null;
      let oracle;
      const observe = () => {
        const meld = meldOf(r);
        if (meld.length < 7) return;
        const g = GameValidator.meldCardGrade(meld, ruleset);
        if (g !== 'clean') oracle = worse(oracle, g);
      };
      observe();
      for (let i = k; i < order.length; i += 1) {
        res = ActionHandlers.handleAddToMeld(r, 'p1', order[i], 0, 0);
        if (!res || res.success === false) return null;
        observe();
      }
      return { r, oracle };
    };

    function* permutations(items) {
      if (items.length <= 1) {
        yield [...items];
        return;
      }
      for (let i = 0; i < items.length; i += 1) {
        const rest = [...items];
        rest.splice(i, 1);
        for (const p of permutations(rest)) yield [items[i], ...p];
      }
    }

    it('the latch is exactly what was seen at seven, and the wire agrees', function () {
      this.timeout(60000);
      const ranks = ['2', '3', '4', '5', '6', '7', '8'];
      let valid = 0;
      const mismatches = [];
      for (const perm of permutations(ranks)) {
        for (let k = 3; k <= perm.length; k += 1) {
          const order = perm.map((x) => c('clubs', x));
          const out = replay(order, k);
          if (!out) continue;
          valid += 1;
          const latched = latchOf(out.r);
          const expectedGrade = GameValidator.meldGrade(meldOf(out.r), ruleset, out.oracle);
          const wire = wireOf(out.r).grade;
          if (latched !== out.oracle || wire !== expectedGrade) {
            if (mismatches.length < 5) {
              mismatches.push(
                `${perm.join('-')} k=${k}: latched ${latched} vs oracle ${out.oracle}, wire ${wire} vs ${expectedGrade}`
              );
            }
          }
        }
      }
      expect(valid, 'sanity: the sweep ran').to.be.greaterThan(10000);
      expect(mismatches, mismatches.join('\n')).to.deep.equal([]);
    });
  });
}
