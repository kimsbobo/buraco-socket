/**
 * Unit tests for the enhanced server-side bot brain (BotStrategy).
 *
 * The strategy mirrors GameValidator meld semantics so its intents pass server
 * validation on the first try: ace-low and ace-high sequences, a same-suit 2
 * acting as a natural, full-width sets (two decks), atomic multi-card
 * add-to-meld, must-meld-aware pile pickup, opponent-feed-aware discards, and
 * batida (close) safety when shedding cards.
 */

const { expect } = require('chai');
const BotStrategy = require('../../src/bots/BotStrategy');

let nextId = 0;
function card(rank, suit) {
  nextId += 1;
  return { cardId: `c${nextId}`, instanceId: `c${nextId}`, rank, suit, isJoker: rank === 'joker' };
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
    yourHand: [],
    playerMelds: {},
    discardPile: [],
    deckCount: 40,
    deadPileCounts: [11],
    pozzettosAvailable: true,
    mustMeldCard: null,
    drawnCardRestriction: [],
    ...overrides,
  };
}

describe('BotStrategy', () => {
  const strategy = new BotStrategy();

  describe('sequence melds', () => {
    it('finds an ace-low sequence (A-2-3) using the same-suit 2 as a natural', () => {
      const hand = [card('A', 'spades'), card('2', 'spades'), card('3', 'spades'), card('9', 'hearts'), card('K', 'diamonds')];
      const intent = strategy.decide(baseState({ yourHand: hand }));
      expect(intent.type).to.equal('play_meld');
      const ranks = intent.cards.map((c) => c.rank).sort();
      expect(ranks).to.deep.equal(['2', '3', 'A']);
    });

    it('finds an ace-high sequence (Q-K-A)', () => {
      const hand = [card('Q', 'hearts'), card('K', 'hearts'), card('A', 'hearts'), card('4', 'clubs'), card('8', 'spades')];
      const intent = strategy.decide(baseState({ yourHand: hand }));
      expect(intent.type).to.equal('play_meld');
      const ranks = intent.cards.map((c) => c.rank).sort();
      expect(ranks).to.deep.equal(['A', 'K', 'Q']);
    });

    it('uses a wild to fill a single-rank gap in a sequence', () => {
      const hand = [card('5', 'clubs'), card('7', 'clubs'), card('8', 'clubs'), card('joker', 'joker'), card('K', 'hearts'), card('3', 'diamonds')];
      const intent = strategy.decide(baseState({ yourHand: hand }));
      expect(intent.type).to.equal('play_meld');
      expect(intent.cards).to.have.length(4);
      expect(intent.cards.some((c) => c.rank === 'joker')).to.equal(true);
    });

    it('never puts a joker in a meld under classicWithNoJoker', () => {
      const hand = [card('5', 'clubs'), card('6', 'clubs'), card('joker', 'joker'), card('K', 'hearts'), card('9', 'diamonds')];
      const intent = strategy.decide(baseState({ ruleset: 'classicWithNoJoker', yourHand: hand }));
      if (intent.type === 'play_meld') {
        expect(intent.cards.some((c) => c.rank === 'joker')).to.equal(false);
      } else {
        expect(intent.type).to.equal('discard_card');
      }
    });
  });

  describe('set melds', () => {
    it('melds every natural copy of a rank, not just four (two decks)', () => {
      const hand = [
        card('9', 'hearts'), card('9', 'hearts'), card('9', 'spades'), card('9', 'clubs'), card('9', 'diamonds'),
        card('3', 'clubs'), card('K', 'diamonds'),
      ];
      const intent = strategy.decide(baseState({ yourHand: hand }));
      expect(intent.type).to.equal('play_meld');
      expect(intent.cards).to.have.length(5);
      expect(intent.cards.every((c) => c.rank === '9')).to.equal(true);
    });

    it('spends a wild to turn six naturals into a canastra', () => {
      const hand = [
        card('Q', 'hearts'), card('Q', 'hearts'), card('Q', 'spades'), card('Q', 'clubs'),
        card('Q', 'diamonds'), card('Q', 'spades'), card('joker', 'joker'),
        card('4', 'clubs'), card('8', 'diamonds'),
      ];
      const intent = strategy.decide(baseState({ yourHand: hand }));
      expect(intent.type).to.equal('play_meld');
      expect(intent.cards).to.have.length(7);
      expect(intent.cards.filter((c) => c.rank === 'joker')).to.have.length(1);
    });

    it('prefers a natural meld over a same-length meld that burns a wild', () => {
      const hand = [
        card('8', 'hearts'), card('8', 'spades'), card('8', 'clubs'),
        card('J', 'hearts'), card('J', 'spades'), card('joker', 'joker'),
        card('4', 'diamonds'),
      ];
      const intent = strategy.decide(baseState({ yourHand: hand }));
      expect(intent.type).to.equal('play_meld');
      expect(intent.cards.every((c) => c.rank === '8')).to.equal(true);
    });
  });

  describe('add to meld', () => {
    it('adds every fitting card in one atomic intent and targets the meld nearest canastra', () => {
      const hand = [card('3', 'hearts'), card('7', 'hearts'), card('8', 'hearts'), card('K', 'clubs'), card('9', 'spades')];
      const state = baseState({
        yourHand: hand,
        playerMelds: {
          1: [[card('4', 'hearts'), card('5', 'hearts'), card('6', 'hearts')]],
        },
      });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('add_to_meld');
      expect(intent.targetPlayerIndex).to.equal(1);
      expect(intent.targetMeldIndex).to.equal(0);
      const ranks = intent.cards.map((c) => c.rank).sort();
      expect(ranks).to.deep.equal(['3', '7', '8']);
    });

    it('holds wilds back unless they complete a canastra', () => {
      const hand = [card('joker', 'joker'), card('K', 'clubs'), card('9', 'spades'), card('4', 'diamonds')];
      const state = baseState({
        yourHand: hand,
        playerMelds: {
          1: [[card('4', 'hearts'), card('5', 'hearts'), card('6', 'hearts')]],
        },
      });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('discard_card');
    });

    it('spends a wild that takes a six-card meld to seven', () => {
      const hand = [card('joker', 'joker'), card('K', 'clubs'), card('9', 'spades')];
      const state = baseState({
        yourHand: hand,
        playerMelds: {
          1: [[
            card('4', 'hearts'), card('5', 'hearts'), card('6', 'hearts'),
            card('7', 'hearts'), card('8', 'hearts'), card('9', 'hearts'),
          ]],
        },
      });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('add_to_meld');
      expect(intent.cards).to.have.length(1);
      expect(intent.cards[0].rank).to.equal('joker');
    });

    it('extends partner melds (team parity) but never opponent melds', () => {
      const hand = [card('7', 'hearts'), card('K', 'clubs'), card('9', 'spades'), card('4', 'diamonds')];
      const state = baseState({
        playerIndex: 1,
        currentPlayerIndex: 1,
        yourHand: hand,
        playerMelds: {
          0: [[card('4', 'hearts'), card('5', 'hearts'), card('6', 'hearts')]], // opponent
          3: [[card('8', 'hearts'), card('9', 'hearts'), card('10', 'hearts')]], // partner
        },
      });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('add_to_meld');
      expect(intent.targetPlayerIndex).to.equal(3);
      expect(intent.cards[0].rank).to.equal('7');
    });
  });

  describe('pile pickup', () => {
    it('takes the pile when the top card extends an own meld', () => {
      const top = card('7', 'hearts');
      const state = baseState({
        hasDrawnCard: false,
        yourHand: [card('K', 'clubs'), card('9', 'spades')],
        discardPile: [card('3', 'clubs'), card('J', 'diamonds'), top],
        playerMelds: { 1: [[card('4', 'hearts'), card('5', 'hearts'), card('6', 'hearts')]] },
      });
      expect(strategy.decide(state).type).to.equal('pick_up_pile');
    });

    it('takes the pile when the top card completes a new meld containing it', () => {
      const top = card('Q', 'hearts');
      const state = baseState({
        hasDrawnCard: false,
        yourHand: [card('Q', 'spades'), card('Q', 'clubs'), card('4', 'diamonds')],
        discardPile: [card('3', 'clubs'), card('8', 'diamonds'), card('J', 'diamonds'), card('5', 'spades'), top],
      });
      expect(strategy.decide(state).type).to.equal('pick_up_pile');
    });

    it('refuses a deep JUNK pile with too few usable cards (avoids hand bloat)', () => {
      const state = baseState({
        hasDrawnCard: false,
        yourHand: [card('4', 'clubs'), card('9', 'spades'), card('K', 'diamonds')],
        // None of these pile cards pair a rank we hold or sit near one of our
        // suits (we hold no hearts), so grabbing the deep pile would only bloat
        // the hand with junk — the bot draws from the deck instead.
        discardPile: [card('7', 'hearts'), card('8', 'hearts'), card('10', 'hearts'), card('6', 'hearts')],
      });
      expect(strategy.decide(state).type).to.equal('draw_card');
    });

    it('takes a deep pile that is rich in usable cards (whole-pile value)', () => {
      const state = baseState({
        hasDrawnCard: false,
        // Hand pairs/near-suits several pile cards: 4♣↔3♣/5♣, 9♠↔10♠, K♦↔Q♦.
        yourHand: [card('4', 'clubs'), card('9', 'spades'), card('K', 'diamonds')],
        discardPile: [card('3', 'clubs'), card('5', 'clubs'), card('10', 'spades'), card('Q', 'diamonds'), card('8', 'hearts')],
      });
      expect(strategy.decide(state).type).to.equal('pick_up_pile');
    });

    // A ONE-card pile is a net-zero trade (take one, discard one), so it is only
    // worth passing up a fresh card when that exact card is immediately usable.
    // "Pairs a rank I hold" is not enough — and because the take never consumes
    // the stock, bots that always preferred it deadlocked whole rounds (the deck
    // never drained, so nobody could ever go out).
    it('draws instead of grabbing a 1-card pile that merely pairs with the hand', () => {
      const state = baseState({
        hasDrawnCard: false,
        yourHand: [card('Q', 'spades'), card('4', 'clubs'), card('9', 'diamonds')],
        discardPile: [card('Q', 'hearts')],
      });
      expect(strategy.decide(state).type).to.equal('draw_card');
    });

    it('does grab a 1-card pile when that card extends one of our melds', () => {
      const state = baseState({
        hasDrawnCard: false,
        yourHand: [card('Q', 'spades'), card('4', 'clubs'), card('9', 'diamonds')],
        discardPile: [card('7', 'hearts')],
        playerMelds: { 1: [[card('4', 'hearts'), card('5', 'hearts'), card('6', 'hearts')]] },
      });
      expect(strategy.decide(state).type).to.equal('pick_up_pile');
    });

    it('declines a useless 1-card pile on a dead stock (the deck-out)', () => {
      // Nothing can change from here — the take would just hand the same card
      // round the table forever. Reporting `wait` is the engine-sanctioned exit:
      // endRoundOnDeckOut ends the round no-batida exactly when the stock is
      // dead "and the pile was declined".
      const state = baseState({
        hasDrawnCard: false,
        deckCount: 0,
        pozzettosAvailable: false,
        deadPileCounts: [0],
        yourHand: [card('Q', 'spades'), card('4', 'clubs')],
        discardPile: [card('Q', 'hearts')],
      });
      expect(strategy.decide(state).type).to.equal('wait');
    });

    it('still takes a DEEP pile on a dead stock — that is real material', () => {
      const state = baseState({
        hasDrawnCard: false,
        deckCount: 0,
        pozzettosAvailable: false,
        deadPileCounts: [0],
        yourHand: [card('4', 'clubs'), card('9', 'spades'), card('K', 'diamonds')],
        discardPile: [
          card('3', 'clubs'), card('5', 'clubs'), card('10', 'spades'),
          card('Q', 'diamonds'), card('8', 'hearts'),
        ],
      });
      expect(strategy.decide(state).type).to.equal('pick_up_pile');
    });
  });

  describe('single-card squeeze guard', () => {
    // Mirrors ActionHandlers.handlePickUpPile: PROFESSIONAL forbids taking a
    // 1-card pile while holding 1 card, so the bot must draw from the deck
    // instead of burning a turn on a guaranteed-rejected pile take. A base rule,
    // not an option — it was once behind a toggle and the toggle is gone.
    // The pile card EXTENDS an own meld, so the bot genuinely wants it — which
    // is what makes this a real control: only the squeeze guard should stop the
    // take, not the bot's own valuation of the pile.
    const squeezeState = () =>
      baseState({
        ruleset: 'professional',
        hasDrawnCard: false,
        yourHand: [card('Q', 'spades')],
        discardPile: [card('7', 'hearts')],
        playerMelds: { 1: [[card('4', 'hearts'), card('5', 'hearts'), card('6', 'hearts')]] },
        deckCount: 40,
      });

    it('draws from the deck instead of taking a 1-card pile at hand==1 (PRO)', () => {
      expect(strategy.decide(squeezeState()).type).to.equal('draw_card');
    });

    it('still takes the same 1-card pile in CLASSIC (control)', () => {
      // Classic is deliberately untouched by the professional rules pass, so the
      // guard must not leak into it — that is what makes this a real control.
      const classicState = baseState({
        ruleset: 'classic',
        hasDrawnCard: false,
        yourHand: [card('Q', 'spades')],
        discardPile: [card('7', 'hearts')],
        playerMelds: { 1: [[card('4', 'hearts'), card('5', 'hearts'), card('6', 'hearts')]] },
        deckCount: 40,
      });
      expect(strategy.decide(classicState).type).to.equal('pick_up_pile');
    });
  });

  describe('discard', () => {
    it('avoids discarding a card the opposing team can add to a meld', () => {
      // No melds/pairs in hand; 7H would normally be a fine discard but feeds
      // the opponents' 4-5-6 hearts run.
      const seven = card('7', 'hearts');
      const state = baseState({
        yourHand: [seven, card('5', 'clubs'), card('9', 'diamonds')],
        playerMelds: { 0: [[card('4', 'hearts'), card('5', 'hearts'), card('6', 'hearts')]] },
      });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('discard_card');
      expect(intent.card.rank).to.not.equal('7');
    });

    it('never volunteers a wild and respects the drawn-card restriction', () => {
      const drawn = card('K', 'spades');
      const state = baseState({
        yourHand: [drawn, card('joker', 'joker'), card('9', 'diamonds')],
        drawnCardRestriction: [String(drawn.cardId)],
      });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('discard_card');
      expect(intent.card.rank).to.equal('9');
    });
  });

  describe('batida (close) safety', () => {
    it('skips a meld that would empty the hand with no canastra and no pozzetto', () => {
      const hand = [card('5', 'clubs'), card('6', 'clubs'), card('7', 'clubs')];
      const state = baseState({
        yourHand: hand,
        pozzettosAvailable: false,
        deadPileCounts: [0],
      });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('discard_card');
    });

    // A team canastra with no well left on the table IS a legal meld-out, in
    // every ruleset and both well modes — _checkInstantEnd carries neither a
    // ruleset nor a mode gate, and it owes a well only while one is still there.
    // Verified against the live handler: this exact position (the brazilia on
    // playerIndex 3, the bot's PARTNER) returns { success:true, roundEnded:… }.
    // The paired negative case is the test above: no canastra anywhere, which the
    // handler really does refuse with { success:false, reason:'mustKeepDiscard' }.
    it('melds out on a team canastra once no well is owed', () => {
      const hand = [card('5', 'clubs'), card('6', 'clubs'), card('7', 'clubs')];
      const state = baseState({
        yourHand: hand,
        pozzettosAvailable: false,
        deadPileCounts: [0],
        playerMelds: {
          3: [[
            card('4', 'hearts'), card('5', 'hearts'), card('6', 'hearts'),
            card('7', 'hearts'), card('8', 'hearts'), card('9', 'hearts'), card('10', 'hearts'),
          ]],
        },
      });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('play_meld');
    });

    // The classic line to claim a well is: meld down to ONE card, discard it, and
    // let the server auto-take the pozzetto (validateDiscard's willTakePozzetto
    // branch) — the discarder keeps the turn with a fresh hand. Verified live:
    // melding 3 of 4 cards with a well on the table returns success and leaves a
    // 1-card hand. The old guard refused this and forfeited the +100 well bonus.
    it('melds down to one card to set up the indirect well take', () => {
      const hand = [card('5', 'clubs'), card('6', 'clubs'), card('7', 'clubs'), card('K', 'diamonds')];
      const state = baseState({ yourHand: hand });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('play_meld');
      expect(intent.cards).to.have.length(3);
    });

    it('will not shed onto a lone card it could not legally discard', () => {
      // No well, no brazilia: the leftover King could not end the turn, so the
      // meld must be skipped (ActionHandlers._rejectIllegalMeldOut would roll it
      // back with 'no card you can legally discard').
      const hand = [card('5', 'clubs'), card('6', 'clubs'), card('7', 'clubs'), card('K', 'diamonds')];
      const state = baseState({
        yourHand: hand,
        pozzettosAvailable: false,
        deadPileCounts: [0],
      });
      expect(strategy.decide(state).type).to.equal('discard_card');
    });
  });

  describe('turn discipline', () => {
    it('waits when it is not its turn', () => {
      const state = baseState({ currentPlayerIndex: 0, yourHand: [card('5', 'clubs')] });
      expect(strategy.decide(state).type).to.equal('wait');
    });

    it('takes the pozzetto with an empty hand', () => {
      const state = baseState({ yourHand: [] });
      expect(strategy.decide(state).type).to.equal('take_pozzetto');
    });
  });
});
