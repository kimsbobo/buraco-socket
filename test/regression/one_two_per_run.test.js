/**
 * "buraco gaboleh double kartu angka 2" — said repeatedly, and the board kept
 * showing it anyway. From the 2026-08-29 screenshot, a vs-bot table:
 *
 *     2♦  3♦  4♦  5♦  [2♠ as 6♦]
 *
 * Two twos in one run. It passed because the wild count cannot see it: a 2 on
 * rank two is NATURAL, so it is not counted as wild, and the run reads as one
 * wild plus a legal natural — while the table shows two 2s side by side.
 *
 * BotStrategy._isValidSequence has carried this exact rule since 2026-08-28
 * with a comment claiming it mirrors GameValidator._isValidSequence. It never
 * did. So the bot proposed runs the server then happily accepted.
 *
 * SETS are untouched on purpose: every card in a set of 2s is a two, and that
 * is the canastra de dois.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const GameValidator = require('../../src/validators/GameValidator');

let id = 0;
const c = (rank, suit) => ({ rank, suit, cardId: (id += 1) });

describe('#one 2 per run', () => {
  for (const ruleset of ['classic', 'professional']) {
    describe(`(${ruleset})`, () => {
      it('THE SCREENSHOT: 2♦-3♦-4♦-5♦ + 2♠ is refused', () => {
        const run = [
          c('2', 'diamonds'), c('3', 'diamonds'),
          c('4', 'diamonds'), c('5', 'diamonds'), c('2', 'spades'),
        ];
        expect(GameValidator._isValidSequence(run, ruleset)).to.equal(false);
      });

      it('two twos of the SAME suit are refused too', () => {
        const run = [
          c('2', 'diamonds'), c('3', 'diamonds'),
          c('4', 'diamonds'), c('2', 'diamonds'),
        ];
        expect(GameValidator._isValidSequence(run, ruleset)).to.equal(false);
      });

      it('a natural 2 ALONE is still a legal run', () => {
        const run = [c('2', 'diamonds'), c('3', 'diamonds'), c('4', 'diamonds')];
        expect(GameValidator._isValidSequence(run, ruleset)).to.equal(true);
      });

      it('a wild 2 ALONE is still a legal run', () => {
        const run = [c('3', 'diamonds'), c('4', 'diamonds'), c('2', 'spades')];
        expect(GameValidator._isValidSequence(run, ruleset)).to.equal(true);
      });

      it('the canastra de dois is untouched — a SET of 2s is legal', () => {
        const set = [c('2', 'spades'), c('2', 'hearts'), c('2', 'diamonds')];
        expect(GameValidator._isValidSet(set, ruleset)).to.equal(true);
      });

      it('a set of another rank still takes its ONE wild 2', () => {
        const set = [c('5', 'spades'), c('5', 'hearts'), c('2', 'diamonds')];
        expect(GameValidator._isValidSet(set, ruleset)).to.equal(true);
      });
    });
  }

  it('classic: a natural 2 may still share a run with a JOKER', () => {
    // The joker is the only wild left that can sit beside a natural two.
    const run = [
      c('2', 'clubs'), c('3', 'clubs'), c('4', 'clubs'),
      c('joker', 'joker'), c('6', 'clubs'),
    ];
    expect(GameValidator._isValidSequence(run, 'classic')).to.equal(true);
  });

  it('the ROYAL run keeps its single natural 2', () => {
    const royal = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
      .map((r) => c(r, 'hearts'));
    expect(GameValidator._isValidSequence(royal, 'classic')).to.equal(true);
  });

  it('BRUTE FORCE: no accepted run anywhere holds two 2s', () => {
    const suits = ['hearts', 'spades', 'diamonds', 'clubs'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    let checked = 0;
    const leaks = [];
    for (const ruleset of ['classic', 'professional']) {
      for (const s of suits) {
        for (const w1 of [...suits.map((x) => ['2', x]), ['joker', 'joker']]) {
          for (const w2 of [...suits.map((x) => ['2', x]), ['joker', 'joker']]) {
            for (let a = 0; a < ranks.length; a += 1) {
              for (let k = 1; k <= 3; k += 1) {
                if (a + k > ranks.length) continue;
                const cards = [c(w1[0], w1[1]), c(w2[0], w2[1])];
                for (let t = 0; t < k; t += 1) cards.push(c(ranks[a + t], s));
                checked += 1;
                if (!GameValidator._isValidSequence(cards, ruleset)) continue;
                if (cards.filter((x) => x.rank === '2').length > 1) {
                  leaks.push(cards.map((x) => x.rank + x.suit[0]).join(' '));
                }
              }
            }
          }
        }
      }
    }
    expect(checked).to.be.greaterThan(5000);
    expect(leaks, `runs accepted with two 2s: ${leaks.slice(0, 5).join(' | ')}`)
      .to.have.length(0);
  });

  // "apakah add to meld ada angka 2 dikartu yang ada di meld, kalo ada dibuat
  // gaboleh" — the ADD path, named directly in the report.
  describe('#the ADD path refuses a second 2', () => {
    const legal = (cards) => GameValidator.meldTwoCountLegal(cards);

    it('a meld holding a 2 refuses another 2, either order', () => {
      // natural first, wild second
      expect(legal([c('2', 'diamonds'), c('3', 'diamonds'), c('4', 'diamonds'), c('2', 'clubs')]))
        .to.equal(false);
      // wild first, natural second
      expect(legal([c('3', 'diamonds'), c('4', 'diamonds'), c('2', 'clubs'), c('2', 'diamonds')]))
        .to.equal(false);
      // same suit twice
      expect(legal([c('2', 'diamonds'), c('3', 'diamonds'), c('4', 'diamonds'), c('2', 'diamonds')]))
        .to.equal(false);
    });

    it('a SET of another rank refuses a second 2 as well', () => {
      expect(legal([c('5', 'spades'), c('5', 'hearts'), c('2', 'diamonds'), c('2', 'clubs')]))
        .to.equal(false);
    });

    it('"2,2,2 itu boleh" — a meld of twos may hold as many as it likes', () => {
      expect(legal([c('2', 'spades'), c('2', 'hearts'), c('2', 'diamonds')])).to.equal(true);
      expect(legal([c('2', 'spades'), c('2', 'hearts'), c('2', 'diamonds'), c('2', 'clubs')]))
        .to.equal(true);
      // a joker standing in inside a meld of twos
      expect(legal([c('2', 'spades'), c('2', 'hearts'), c('joker', 'joker')])).to.equal(true);
    });

    it('one 2 is always fine', () => {
      expect(legal([c('2', 'diamonds'), c('3', 'diamonds'), c('4', 'diamonds')])).to.equal(true);
      expect(legal([c('3', 'diamonds'), c('4', 'diamonds'), c('2', 'clubs')])).to.equal(true);
    });
  });
});
