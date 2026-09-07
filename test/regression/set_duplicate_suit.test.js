/**
 * #7 — a set may legally contain duplicate suits (two decks), e.g. A♥ A♥ A♦.
 * The server used to reject duplicate suits while the client allowed them,
 * causing valid melds to be refused.
 */

const { expect } = require('chai');
const GameValidator = require('../../src/validators/GameValidator');

const card = (suit, rank) => ({ suit, rank });

describe('#7 set allows duplicate suits', () => {
  it('accepts a set of three Aces with a repeated suit (A♥ A♥ A♦)', () => {
    const cards = [card('hearts', 'A'), card('hearts', 'A'), card('diamonds', 'A')];
    expect(GameValidator._isValidSet(cards, 'classic')).to.equal(true);
  });

  it('still rejects a "set" of mixed ranks', () => {
    const cards = [card('hearts', 'A'), card('hearts', 'K'), card('diamonds', 'A')];
    expect(GameValidator._isValidSet(cards, 'classic')).to.equal(false);
  });

  it('still rejects more than one wildcard', () => {
    const cards = [card('hearts', 'A'), card('joker', 'joker'), card('clubs', '2')];
    expect(GameValidator._isValidSet(cards, 'classic')).to.equal(false);
  });
});
