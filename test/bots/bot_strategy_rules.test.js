/**
 * Rule-adaptive / smarter-play tests for the server-side bot brain.
 *
 * These cover the legality gates the strategy added so it never spends a turn
 * on an intent GameValidator would reject: professional take-well needs a team
 * brazilia, going out needs a brazilia + the well taken + a legal final discard,
 * and shedding the hand only happens when a legal exit (well or close) exists.
 * They also cover the "smarter" behaviours: completing a brazilia and keeping it
 * clean by preferring a natural over a wild.
 */

const { expect } = require('chai');
const BotStrategy = require('../../src/bots/BotStrategy');

let nextId = 0;
function card(rank, suit) {
  nextId += 1;
  return { cardId: `r${nextId}`, instanceId: `r${nextId}`, rank, suit, isJoker: rank === 'joker' };
}

function baseState(overrides = {}) {
  return {
    roomId: 'r1',
    playerId: 'bot-1',
    playerIndex: 1,
    currentPlayerIndex: 1,
    cardsDealt: true,
    hasDrawnCard: true,
    meldedThisTurn: false,
    ruleset: 'classic',
    professionalWellMode: 'indirect',
    yourHand: [],
    playerMelds: {},
    discardPile: [],
    deckCount: 40,
    deadPileCounts: [11],
    pozzettosAvailable: true,
    teamHasTakenPozzetto: false,
    mustMeldCard: null,
    drawnCardRestriction: [],
    ...overrides,
  };
}

// A 7-card partner sequence (a brazilia) the bot's team owns. Partner of index 1
// is index 3 (same parity).
function partnerBrazilia() {
  return {
    3: [[
      card('4', 'spades'), card('5', 'spades'), card('6', 'spades'),
      card('7', 'spades'), card('8', 'spades'), card('9', 'spades'), card('10', 'spades'),
    ]],
  };
}

// The same brazilia, but on the bot's OWN meld list (index 1). The instant-end
// paths in ActionHandlers._checkInstantEnd read the actor's own melds only, so
// own vs partner ownership changes what is legal.
function ownBrazilia() {
  return {
    1: [[
      card('4', 'spades'), card('5', 'spades'), card('6', 'spades'),
      card('7', 'spades'), card('8', 'spades'), card('9', 'spades'), card('10', 'spades'),
    ]],
  };
}

describe('BotStrategy rule-adaptive play', () => {
  const strategy = new BotStrategy();

  describe('take pozzetto legality (professional)', () => {
    it('never attempts take_pozzetto with an empty hand when the team has no brazilia', () => {
      const state = baseState({ ruleset: 'professional', yourHand: [], playerMelds: {} });
      const intent = strategy.decide(state);
      expect(intent.type).to.not.equal('take_pozzetto');
      expect(intent.type).to.equal('wait');
    });

    it('takes the well with an empty hand once the team has a brazilia', () => {
      const state = baseState({ ruleset: 'professional', yourHand: [], playerMelds: partnerBrazilia() });
      expect(strategy.decide(state).type).to.equal('take_pozzetto');
    });

    it('still takes the well freely in classic with an empty hand (no brazilia needed)', () => {
      const state = baseState({ ruleset: 'classic', yourHand: [], playerMelds: {} });
      expect(strategy.decide(state).type).to.equal('take_pozzetto');
    });
  });

  describe('going out legality', () => {
    it('never melds its whole hand out in professional without a brazilia (no well to take either)', () => {
      const hand = [card('5', 'clubs'), card('6', 'clubs'), card('7', 'clubs')];
      const state = baseState({
        ruleset: 'professional',
        yourHand: hand,
        playerMelds: {},
        pozzettosAvailable: false,
        deadPileCounts: [0, 0],
      });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('discard_card');
    });

    it('never empties its hand into a well it cannot legally take (professional, no brazilia)', () => {
      // A well is on the table but unusable: professional take-well needs a
      // brazilia the team does not have. Emptying would wedge, so it must discard.
      const hand = [card('5', 'clubs'), card('6', 'clubs'), card('7', 'clubs')];
      const state = baseState({
        ruleset: 'professional',
        yourHand: hand,
        playerMelds: {},
        pozzettosAvailable: true,
        teamHasTakenPozzetto: false,
        deadPileCounts: [11, 11],
      });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('discard_card');
    });

    it('empties its hand into an available well once it has a brazilia (then takes the well)', () => {
      const hand = [card('5', 'clubs'), card('6', 'clubs'), card('7', 'clubs')];
      const state = baseState({
        ruleset: 'professional',
        yourHand: hand,
        playerMelds: partnerBrazilia(),
        pozzettosAvailable: true,
        teamHasTakenPozzetto: false,
        deadPileCounts: [11, 11],
      });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('play_meld');
    });

    // A MELD-OUT closes the round in BOTH well modes — ActionHandlers
    // ._checkInstantEnd carries no mode gate. The bot used to demand
    // professionalWellMode === 'direct' here and therefore declined every legal
    // INDIRECT meld-out, throwing away won rounds. Verified against the live
    // handler: this exact state returns { success:true, roundEnded:<result> }.
    it('melds out in professional-INDIRECT too, with a brazilia and the well taken', () => {
      const hand = [card('5', 'clubs'), card('6', 'clubs'), card('7', 'clubs')];
      const state = baseState({
        ruleset: 'professional',
        professionalWellMode: 'indirect',
        yourHand: hand,
        playerMelds: partnerBrazilia(),
        pozzettosAvailable: false,
        teamHasTakenPozzetto: true,
        deadPileCounts: [0, 0],
      });
      expect(strategy.decide(state).type).to.equal('play_meld');
    });

    it('melds out in professional-DIRECT when its OWN melds hold the brazilia', () => {
      const hand = [card('5', 'clubs'), card('6', 'clubs'), card('7', 'clubs')];
      const state = baseState({
        ruleset: 'professional',
        professionalWellMode: 'direct',
        yourHand: hand,
        playerMelds: ownBrazilia(),
        pozzettosAvailable: false,
        teamHasTakenPozzetto: true,
        deadPileCounts: [0, 0],
      });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('play_meld');
      expect(intent.cards).to.have.length(3);
    });

    // ...and equally when the brazilia sits on the PARTNER'S half of the table.
    // The brazilia question is TEAM scoped on both sides — _checkInstantEnd reads
    // _teamMelds, exactly like the closing discard, _canTakeWellAfterEmptyHand
    // and the -200 noBrazilia penalty always did. It briefly read the ACTOR'S own
    // melds instead, and because a meld-out is the ONLY close DIRECT has, that
    // made a 2v2 round unfinishable for a side whose canasta happened to be on
    // the partner's side. Verified live: { success:true, roundEnded:<result> }.
    it('melds out in professional-DIRECT when the PARTNER holds the brazilia', () => {
      const hand = [card('5', 'clubs'), card('6', 'clubs'), card('7', 'clubs')];
      const state = baseState({
        ruleset: 'professional',
        professionalWellMode: 'direct',
        yourHand: hand,
        playerMelds: partnerBrazilia(),
        pozzettosAvailable: false,
        teamHasTakenPozzetto: true,
        deadPileCounts: [0, 0],
      });
      expect(strategy.decide(state).type).to.equal('play_meld');
    });

    it('picks a legal final card when the last discard closes the round', () => {
      const state = baseState({
        ruleset: 'classic',
        yourHand: [card('5', 'clubs')],
        playerMelds: partnerBrazilia(),
        pozzettosAvailable: false,
        teamHasTakenPozzetto: true,
        deadPileCounts: [0],
      });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('discard_card');
      expect(intent.card.rank).to.equal('5');
    });
  });

  describe('building and completing a brazilia', () => {
    it('adds the natural that turns a six-card meld into a brazilia', () => {
      const hand = [card('10', 'clubs'), card('K', 'hearts'), card('3', 'diamonds')];
      const state = baseState({
        yourHand: hand,
        playerMelds: {
          1: [[
            card('4', 'clubs'), card('5', 'clubs'), card('6', 'clubs'),
            card('7', 'clubs'), card('8', 'clubs'), card('9', 'clubs'),
          ]],
        },
      });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('add_to_meld');
      expect(intent.cards).to.have.length(1);
      expect(intent.cards[0].rank).to.equal('10');
      // Six in the meld + the one added = a seven-card brazilia.
      const meldLen = state.playerMelds[1][0].length + intent.cards.length;
      expect(meldLen).to.be.at.least(7);
    });

    it('completes a brazilia with a natural rather than burning a wild (keeps it clean)', () => {
      const hand = [card('10', 'clubs'), card('joker', 'joker'), card('K', 'spades')];
      const state = baseState({
        yourHand: hand,
        playerMelds: {
          1: [[
            card('4', 'clubs'), card('5', 'clubs'), card('6', 'clubs'),
            card('7', 'clubs'), card('8', 'clubs'), card('9', 'clubs'),
          ]],
        },
      });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('add_to_meld');
      expect(intent.cards).to.have.length(1);
      expect(intent.cards[0].rank).to.equal('10');
      expect(intent.cards.some((c) => c.rank === 'joker')).to.equal(false);
    });
  });

  describe('legal discard choice', () => {
    it('never discards a wild and avoids feeding an opponent meld', () => {
      const seven = card('7', 'hearts');
      const state = baseState({
        yourHand: [seven, card('joker', 'joker'), card('9', 'diamonds')],
        playerMelds: { 0: [[card('4', 'hearts'), card('5', 'hearts'), card('6', 'hearts')]] },
      });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('discard_card');
      expect(intent.card.rank).to.not.equal('joker');
      expect(intent.card.rank).to.not.equal('7'); // 7H would extend the opponents' 4-5-6
      expect(intent.card.rank).to.equal('9');
    });
  });
});
