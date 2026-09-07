// A VOIDED ROUND IS A FLAT VERDICT, AND IT GETS DEARER EVERY TIME — socket side.
//
// Product owner, 2026-09-02:
//   "dia point pas game endednya flat -200, yang ditangan player itu ga perlu
//    dihitung, dan berlaku -200 kelipatan tiap ronde ... berarti jadi -400"
//   plus, asked directly: count EVERY voided round in the match, never reset by
//   a good round; a new match starts fresh.
//
// The client mirror is buraco_sdk/test/void_multiplies_across_rounds_test.dart
// and carries the same cases on purpose — a divergence here is a divergence a
// player sees between an online table and a vs-bot one.
const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');

describe('#void charge multiplies across the match', () => {
  const voidTotal = (ordinal, turnPenalty = 0) =>
    ActionHandlers._voidedRoundTotal({
      reasons: ['no_pozzetto', 'no_brazilia'],
      turnPenalty,
      voidOrdinal: ordinal,
    });

  it('the first voided round is a flat -200', () => {
    expect(voidTotal(1)).to.equal(-200);
  });

  it('the second is -400 and the third -600', () => {
    expect(voidTotal(2)).to.equal(-400);
    expect(voidTotal(3)).to.equal(-600);
  });

  it('the cards in hand are NOT part of it', () => {
    // The signature no longer takes a hand penalty at all — the only way to
    // charge one would be to add it back, which is the reversal this guards.
    expect(ActionHandlers._voidedRoundTotal.length).to.be.at.most(1);
    expect(voidTotal(1)).to.equal(-200);
  });

  it('a turn penalty still comes off, on top of the multiplied charge', () => {
    // The turn penalty is a charge for something the side DID; the hand is a
    // valuation of what it was left holding. Only the second is forgiven.
    expect(voidTotal(2, 100)).to.equal(-500);
  });

  it('a missing or zero ordinal is treated as the first void', () => {
    expect(
      ActionHandlers._voidedRoundTotal({
        reasons: ['no_pozzetto', 'no_brazilia'],
        turnPenalty: 0,
      })
    ).to.equal(-200);
    expect(voidTotal(0)).to.equal(-200);
  });

  it('ONE failed obligation is -100 and does not multiply into a void', () => {
    // A single miss is a line item inside the round, not a verdict. It reaches
    // _voidedRoundTotal only through a caller that has already decided the
    // round IS void, so a one-reason call is not a real position — but if it
    // ever happened it must not be multiplied into one.
    expect(
      ActionHandlers._voidedRoundTotal({
        reasons: ['no_pozzetto'],
        turnPenalty: 0,
        voidOrdinal: 1,
      })
    ).to.equal(-100);
  });
});
