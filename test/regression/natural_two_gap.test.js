/**
 * A gap elsewhere in the run must not demote an on-suit 2 to a WILD.
 *
 * REPORTED LIVE, from a screenshot: a 2♣ sitting in its own slot showed a blue
 * "represents 2" chip and its canasta scored dirty.
 *
 * `_isNaturalTwo` demanded the WHOLE run be gapless — it dropped the other wild
 * from the layout and then rejected any gap at all. So a wild plugging a hole
 * somewhere else demoted the on-suit 2, and two things followed from that single
 * wrong answer:
 *
 *   * `_isCleanMeld` counted the 2 as a wild → the canasta scored DIRTY;
 *   * `orderMeldCards` then treated the 2 as THE wild and stamped it
 *     `representedRank: '2'` — a card standing in for its own rank.
 *
 * The Flutter client mirrors the predicate in GameRules.isNaturalTwoInMeld.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const GameValidator = require('../../src/validators/GameValidator');

const c = (rank, suit) => ({ rank, suit });

/** 2♣ 3♣ 4♣ 5♣ 6♣ 7♣ [2♦ fills 8] 9♣ — an off-suit 2 is the wild. */
const RUN_WITH_FILLED_GAP = () => [
  c('2', 'clubs'),
  c('3', 'clubs'),
  c('4', 'clubs'),
  c('5', 'clubs'),
  c('6', 'clubs'),
  c('7', 'clubs'),
  c('2', 'diamonds'),
  c('9', 'clubs'),
];

/**
 * The same shape with a JOKER as the filler, which is the only version still
 * legal: ONE 2 PER RUN (2026-08-28) bans a run holding both the natural 2♣ and
 * a second 2 acting as the wild. Jokers are classic-only, which is why the
 * gaps-vs-fillers rule now only has a subject outside professional.
 */
const RUN_WITH_JOKER_GAP = () => [
  c('2', 'clubs'),
  c('3', 'clubs'),
  c('4', 'clubs'),
  c('5', 'clubs'),
  c('6', 'clubs'),
  c('7', 'clubs'),
  c('joker', 'joker'),
  c('9', 'clubs'),
];

describe('#natural two with a gap elsewhere', () => {
  it('the on-suit 2 stays NATURAL and the off-suit 2 is the wild', () => {
    const cards = RUN_WITH_FILLED_GAP();
    const onSuit = cards[0];
    const offSuit = cards[6];

    expect(GameValidator._isNaturalTwo(onSuit, cards), '2♣ is natural').to.equal(true);
    expect(GameValidator._isNaturalTwo(offSuit, cards), '2♦ is the wild').to.equal(false);
  });

  it('the run with a JOKER filler is a VALID sequence — one wild, one gap', () => {
    // With the 2♣ demoted this counted TWO wilds and the whole meld was rejected.
    expect(GameValidator._isValidSequence(RUN_WITH_JOKER_GAP(), 'classic')).to.equal(true);
  });

  it('but the same run filled by a SECOND 2 is refused — one 2 per run', () => {
    // Product decision 2026-08-28. The wild count cannot catch this on its own:
    // the on-suit 2 is NATURAL, not a wild, so this meld counted exactly one
    // wild and used to pass. Reported live from a screenshot of A♣-2♣-[2♥]-4♣.
    expect(GameValidator._isValidSequence(RUN_WITH_FILLED_GAP(), 'professional')).to.equal(false);
    expect(GameValidator._isValidSequence(RUN_WITH_FILLED_GAP(), 'classic')).to.equal(false);

    const reported = [c('A', 'clubs'), c('2', 'clubs'), c('2', 'hearts'), c('4', 'clubs')];
    expect(GameValidator._isValidSequence(reported, 'professional')).to.equal(false);
    expect(GameValidator._isValidSequence(reported, 'classic')).to.equal(false);
  });

  it('a SET of 2s is untouched — the canastra de dois still stands', () => {
    // The guard is scoped to _isValidSequence on purpose: banning 2s outright
    // would delete a 2000-point meld.
    const setOfTwos = [
      c('2', 'spades'), c('2', 'hearts'), c('2', 'diamonds'), c('2', 'clubs'),
      c('2', 'spades'), c('2', 'hearts'), c('2', 'diamonds'),
    ];
    expect(GameValidator._isValidSet(setOfTwos, 'professional')).to.equal(true);
  });

  it('orderMeldCards labels the JOKER, never the on-suit 2', () => {
    const cards = RUN_WITH_JOKER_GAP();
    const onSuit = cards[0];
    const joker = cards[6];

    GameValidator.orderMeldCards(cards, 'classic');

    expect(onSuit.representedRank, 'a two does not stand in for a two').to.equal(undefined);
    expect(joker.representedRank, 'the joker fills the real gap').to.equal('8');
  });

  it('a gapless run of the same shape is CLEAN', () => {
    const clean = [
      c('2', 'clubs'), c('3', 'clubs'), c('4', 'clubs'), c('5', 'clubs'),
      c('6', 'clubs'), c('7', 'clubs'), c('8', 'clubs'),
    ];
    expect(GameValidator._isCleanMeld(clean)).to.equal(true);
  });

  it('a 2 with a gap NO wild can fill is still a wild', () => {
    // 2♣ 5♣ 6♣ 7♣ — nothing bridges 3 and 4, so the 2 cannot sit at rank two.
    const cards = [c('2', 'clubs'), c('5', 'clubs'), c('6', 'clubs'), c('7', 'clubs')];
    expect(GameValidator._isNaturalTwo(cards[0], cards)).to.equal(false);
  });

  it('a joker fills the gap just as well', () => {
    const cards = [
      c('2', 'clubs'), c('3', 'clubs'), c('4', 'clubs'), c('5', 'clubs'),
      c('6', 'clubs'), c('7', 'clubs'), c('joker', 'joker'), c('9', 'clubs'),
    ];
    expect(GameValidator._isNaturalTwo(cards[0], cards)).to.equal(true);
    // ...in a ruleset that allows jokers at all.
    expect(GameValidator._isValidSequence(cards, 'classic')).to.equal(true);
    expect(GameValidator._isValidSequence(cards, 'professional')).to.equal(false);
  });

  it('the second copy of the same 2 is a filler, not a twin natural', () => {
    const cards = [
      c('2', 'clubs'), c('2', 'clubs'), c('3', 'clubs'), c('4', 'clubs'),
    ];
    // Either copy reads at rank two with the other as the available filler, so
    // neither is disqualified merely by the other being there. The duplicate rank
    // is what _isValidSequence rejects, and that is its job, not this predicate's.
    expect(GameValidator._isNaturalTwo(cards[0], cards)).to.equal(true);
    expect(GameValidator._isValidSequence(cards, 'professional')).to.equal(false);
  });
});
