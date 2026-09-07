/**
 * House rule: a SET OF ALL 2s is a legal meld (2 treated as its natural rank).
 * A joker may fill in as the single wild (classic only — professional bans jokers
 * from sets), but a joker-only group is NOT a meld.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const GameValidator = require('../../src/validators/GameValidator');

const c = (suit, rank, id) => ({ suit, rank, cardId: id });

describe('#set of all 2s (house rule)', () => {
  for (const ruleset of ['classic', 'professional']) {
    it(`accepts a pure set of three 2s (${ruleset})`, () => {
      const cards = [c('spades', '2', 1), c('hearts', '2', 2), c('diamonds', '2', 3)];
      expect(GameValidator._isValidSet(cards, ruleset)).to.equal(true);
    });

    it(`rejects a joker-only group (${ruleset})`, () => {
      const cards = [c('joker', 'joker', 1), c('joker', 'joker', 2), c('joker', 'joker', 3)];
      expect(GameValidator._isValidSet(cards, ruleset)).to.equal(false);
    });

    it(`rejects more than one wild in a 2s-set (${ruleset})`, () => {
      const cards = [c('spades', '2', 1), c('joker', 'joker', 2), c('joker', 'joker', 3)];
      expect(GameValidator._isValidSet(cards, ruleset)).to.equal(false);
    });
  }

  it('accepts a 2s-set with a single joker wild (classic)', () => {
    const cards = [c('spades', '2', 1), c('hearts', '2', 2), c('joker', 'joker', 3)];
    expect(GameValidator._isValidSet(cards, 'classic')).to.equal(true);
  });

  it('still accepts a normal set that uses a 2 as its single wild', () => {
    const cards = [c('spades', 'K', 1), c('hearts', 'K', 2), c('diamonds', '2', 3)];
    expect(GameValidator._isValidSet(cards, 'classic')).to.equal(true);
  });
});
