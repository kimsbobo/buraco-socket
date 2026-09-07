/* eslint-env mocha */

/**
 * Coverage for the "smarter bot" behaviours added on top of the legality floor.
 *
 * Two groups live here:
 *   1. RULE PARITY the strategy previously did not model at all — the set-of-2s
 *      house rule, the strict natural-two test, an end-extending wild, the
 *      TWO-wells-per-team cap. Each of these was a
 *      missed legal move or (worse) an intent the server rejects, and every
 *      rejection costs a real round trip the human watches.
 *   2. JUDGEMENT — real Brazilia card values, wild economy, opponent threat from
 *      public hand counts, the professional per-turn points requirement, and the
 *      difficulty tiers driven by PlayerSession.botLevel.
 */

const { expect } = require('chai');
const GameValidator = require('../../src/validators/GameValidator');
const BotStrategy = require('../../src/bots/BotStrategy');

let nextId = 0;
function card(rank, suit) {
  nextId += 1;
  return { cardId: `s${nextId}`, instanceId: `s${nextId}`, rank, suit, isJoker: rank === 'joker' };
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
    drawnCardRestriction: [],
    ...overrides,
  };
}

const ranksOf = (cards) => cards.map((c) => c.rank).sort();

describe('BotStrategy — rule parity the old brain was blind to', () => {
  const strategy = new BotStrategy();

  describe('set of all 2s (house rule)', () => {
    it('opens a seven-card set of 2s — the professional instant win', () => {
      const twos = [
        card('2', 'hearts'), card('2', 'spades'), card('2', 'clubs'), card('2', 'diamonds'),
        card('2', 'hearts'), card('2', 'spades'), card('2', 'clubs'),
      ];
      const intent = strategy.decide(baseState({
        ruleset: 'professional',
        yourHand: [...twos, card('K', 'diamonds'), card('9', 'clubs')],
      }));
      expect(intent.type).to.equal('play_meld');
      expect(intent.cards).to.have.length(7);
      expect(intent.cards.every((c) => c.rank === '2')).to.equal(true);
    });

    it('extends an existing set of 2s with another 2 (a 2 is that meld\'s NATURAL)', () => {
      const intent = strategy.decide(baseState({
        yourHand: [card('2', 'hearts'), card('K', 'diamonds'), card('9', 'clubs'), card('4', 'spades')],
        playerMelds: { 1: [[card('2', 'spades'), card('2', 'clubs'), card('2', 'diamonds')]] },
      }));
      expect(intent.type).to.equal('add_to_meld');
      expect(intent.cards).to.have.length(1);
      expect(intent.cards[0].rank).to.equal('2');
    });

    it('does not open a THREE-card set of 2s — it only pays at seven', () => {
      const intent = strategy.decide(baseState({
        yourHand: [
          card('2', 'hearts'), card('2', 'spades'), card('2', 'clubs'),
          card('K', 'diamonds'), card('9', 'clubs'),
        ],
      }));
      expect(intent.type).to.equal('discard_card');
    });
  });

  describe('natural two — the bot reads it the way the SERVER does', () => {
    // This block used to assert the opposite, on a premise that was simply
    // untrue: "GameValidator._isNaturalTwo only promotes a same-suit 2 when the
    // naturals are strictly consecutive ... and the server rejects it". Run
    // against the shipped validator, `2H 3H [joker] 5H` is ACCEPTED — the server
    // reads gaps-vs-fillers, so a hole another wild plugs does not demote a 2
    // sitting on its own rank.
    //
    // So the old test was pinning the BOT's stricter copy in place, and the bot
    // was declining legal, free extensions. It could never emit something the
    // server refused, so nothing leaked; it just played worse, and vs-bot
    // stopped being the same game as online.
    it('MAY emit 2-3-[joker]-5, because the server accepts it', () => {
      expect(
        GameValidator._isValidSequence(
          [card('2', 'hearts'), card('3', 'hearts'), card('joker', 'joker'), card('5', 'hearts')],
          'classic'
        ),
        'the premise: the server accepts this run'
      ).to.equal(true);

      const intent = strategy.decide(baseState({
        yourHand: [
          card('2', 'hearts'), card('3', 'hearts'), card('5', 'hearts'),
          card('joker', 'joker'), card('K', 'spades'), card('9', 'clubs'),
        ],
      }));
      // Whatever it chooses, the SERVER must accept it — that is the real rule.
      if (intent.type === 'play_meld') {
        expect(
          GameValidator._isValidSequence(intent.cards, 'classic')
            || GameValidator._isValidSet(intent.cards, 'classic'),
          `server refused what the bot proposed: ${intent.cards.map((c) => c.rank + c.suit[0]).join(' ')}`
        ).to.equal(true);
      } else {
        expect(intent.type).to.equal('discard_card');
      }
    });

    it('PARITY: the bot never proposes a run the server would refuse', () => {
      // The only direction that can actually hurt. Exhaustive over one suit.
      const suits = ['hearts', 'spades', 'diamonds', 'clubs'];
      const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
      const wilds = [...suits.map((s) => ['2', s]), ['joker', 'joker']];
      const looser = [];
      for (const s of suits) {
        for (const w of wilds) {
          for (let a = 0; a < ranks.length; a += 1) {
            for (let k = 2; k <= 4; k += 1) {
              if (a + k > ranks.length) continue;
              const cards = [card(w[0], w[1])];
              for (let t = 0; t < k; t += 1) cards.push(card(ranks[a + t], s));
              const server = GameValidator._isValidSequence(cards, 'classic');
              const botSays = strategy._isValidSequence(cards, { noJoker: false });
              if (botSays && !server) {
                looser.push(cards.map((c) => c.rank + c.suit[0]).join(' '));
              }
            }
          }
        }
      }
      expect(looser, `bot LOOSER than the server on: ${looser.slice(0, 5).join(' | ')}`)
        .to.have.length(0);
    });

    it('still uses a same-suit 2 as a natural in a gapless run (A-2-3)', () => {
      const intent = strategy.decide(baseState({
        yourHand: [
          card('A', 'spades'), card('2', 'spades'), card('3', 'spades'),
          card('9', 'hearts'), card('K', 'diamonds'),
        ],
      }));
      expect(intent.type).to.equal('play_meld');
      expect(ranksOf(intent.cards)).to.deep.equal(['2', '3', 'A']);
    });
  });

  it('opens a canastra in ONE action with six naturals plus an end-extending wild', () => {
    // The server allows a wild to EXTEND a complete run at an end, at any
    // length. The old generator only tried that on a two-natural run, so it
    // could never find this seven-card meld and had to build it over two turns.
    const intent = strategy.decide(baseState({
      yourHand: [
        card('4', 'clubs'), card('5', 'clubs'), card('6', 'clubs'),
        card('7', 'clubs'), card('8', 'clubs'), card('9', 'clubs'),
        card('joker', 'joker'), card('K', 'hearts'), card('3', 'diamonds'),
      ],
    }));
    expect(intent.type).to.equal('play_meld');
    expect(intent.cards).to.have.length(7);
    expect(intent.cards.filter((c) => c.rank === 'joker')).to.have.length(1);
  });

  describe('two wells per team (house rule)', () => {
    it('still counts on the SECOND well after the first was banked', () => {
      const intent = strategy.decide(baseState({
        yourHand: [card('5', 'clubs'), card('6', 'clubs'), card('7', 'clubs')],
        teamHasTakenPozzetto: true,
        teamWellsTaken: 1,
        pozzettosAvailable: true,
      }));
      expect(intent.type).to.equal('play_meld');
    });

    it('stops treating the well as an exit once the team has taken both', () => {
      const intent = strategy.decide(baseState({
        yourHand: [card('5', 'clubs'), card('6', 'clubs'), card('7', 'clubs')],
        teamHasTakenPozzetto: true,
        teamWellsTaken: 2,
        pozzettosAvailable: true,
      }));
      expect(intent.type).to.equal('discard_card');
    });
  });

  it('takes the pile rather than burning the last well on a dead stock', () => {
    // Drawing with an empty stock PROMOTES the pozzetto into the deck, which
    // destroys it as a well: nobody is credited and the -100 no-well penalty
    // becomes unavoidable. With a well still owed to us, the pile take is better.
    const intent = strategy.decide(baseState({
      hasDrawnCard: false,
      deckCount: 0,
      pozzettosAvailable: true,
      deadPileCounts: [11],
      yourHand: [card('K', 'spades'), card('4', 'clubs')],
      discardPile: [card('9', 'hearts'), card('J', 'spades')],
    }));
    expect(intent.type).to.equal('pick_up_pile');
  });

  it('reports `wait` (not a doomed discard) when no discard is legal', () => {
    // A lone wild in classic can never close, so nothing is discardable. Saying
    // so lets BotCoordinator._forceTurnProgress resolve the turn in one step
    // instead of paying for a guaranteed server rejection first.
    const intent = strategy.decide(baseState({
      yourHand: [card('joker', 'joker')],
      pozzettosAvailable: false,
      deadPileCounts: [0],
    }));
    expect(intent.type).to.equal('wait');
  });
});

describe('BotStrategy — judgement', () => {
  const strategy = new BotStrategy();

  it('will not burn a wild to open a bare three-card meld', () => {
    // The wild is worth more later (completing a canastra) than a 3-card meld is
    // now. 3H+5H+joker is perfectly legal — the bot just declines the trade.
    const intent = strategy.decide(baseState({
      yourHand: [
        card('3', 'hearts'), card('5', 'hearts'), card('joker', 'joker'),
        card('K', 'spades'), card('9', 'clubs'),
      ],
    }));
    expect(intent.type).to.equal('discard_card');
  });

  it('does spend that wild when the professional points requirement is unmet', () => {
    const intent = strategy.decide(baseState({
      ruleset: 'professional',
      requiredMeldPoints: 75,
      meldPointsThisTurn: 0,
      yourHand: [
        card('3', 'hearts'), card('5', 'hearts'), card('2', 'clubs'),
        card('K', 'spades'), card('9', 'clubs'),
      ],
    }));
    expect(intent.type).to.equal('play_meld');
  });

  it('prefers the higher-POINT meld over the longer one when short of the requirement', () => {
    // Three aces = 45 pts (3 cards); four fours = 20 pts (4 cards). Without the
    // requirement the longer meld wins; with it, points win.
    const hand = [
      card('A', 'clubs'), card('A', 'spades'), card('A', 'hearts'),
      card('4', 'diamonds'), card('4', 'spades'), card('4', 'clubs'), card('4', 'hearts'),
      card('K', 'diamonds'),
    ];
    const relaxed = strategy.decide(baseState({ ruleset: 'professional', yourHand: hand }));
    expect(relaxed.cards.every((c) => c.rank === '4')).to.equal(true);

    const pressured = strategy.decide(baseState({
      ruleset: 'professional',
      requiredMeldPoints: 75,
      meldPointsThisTurn: 0,
      yourHand: hand,
    }));
    expect(pressured.cards.every((c) => c.rank === 'A')).to.equal(true);
  });

  it('sheds the biggest penalty card once an opponent can close at any moment', () => {
    // Opponent team holds a brazilia, has banked its well and is down to one card.
    // Holding a 15-point ace to "see what comes" is how a bot loses a round.
    const threatened = baseState({
      yourHand: [card('A', 'clubs'), card('3', 'diamonds'), card('9', 'spades')],
      playerMelds: {
        0: [[
          card('4', 'hearts'), card('5', 'hearts'), card('6', 'hearts'), card('7', 'hearts'),
          card('8', 'hearts'), card('9', 'hearts'), card('10', 'hearts'),
        ]],
      },
      handCounts: { 0: 1, 1: 3, 2: 11, 3: 11 },
      opponentTeamHasTakenPozzetto: true,
      opponentWellsTaken: 1,
    });
    const intent = strategy.decide(threatened);
    expect(intent.type).to.equal('discard_card');
    expect(intent.card.rank).to.equal('A');
  });

  it('refuses a deep pile it would otherwise take when an opponent is about to go out', () => {
    const pile = [
      card('3', 'clubs'), card('5', 'clubs'), card('10', 'spades'),
      card('Q', 'diamonds'), card('8', 'hearts'),
    ];
    const hand = [card('4', 'clubs'), card('9', 'spades'), card('K', 'diamonds')];

    const calm = baseState({ hasDrawnCard: false, yourHand: hand, discardPile: pile });
    expect(strategy.decide(calm).type).to.equal('pick_up_pile');

    const threatened = baseState({
      hasDrawnCard: false,
      yourHand: hand,
      discardPile: pile,
      playerMelds: {
        0: [[
          card('4', 'hearts'), card('5', 'hearts'), card('6', 'hearts'), card('7', 'hearts'),
          card('8', 'hearts'), card('9', 'hearts'), card('10', 'hearts'),
        ]],
      },
      handCounts: { 0: 1, 1: 3, 2: 11, 3: 11 },
      opponentTeamHasTakenPozzetto: true,
      opponentWellsTaken: 1,
    });
    expect(strategy.decide(threatened).type).to.equal('draw_card');
  });

  it('uses real Brazilia card values, not raw rank order', () => {
    // Raw rank order ranks a 2 (value 2) below a 3; the game scores a 2 at 20 in
    // classic. Between two otherwise useless naturals the bot sheds the one that
    // actually costs more if the round ends with it in hand.
    const intent = strategy.decide(baseState({
      yourHand: [card('A', 'clubs'), card('3', 'diamonds'), card('4', 'spades')],
    }));
    expect(intent.type).to.equal('discard_card');
    expect(intent.card.rank).to.equal('A'); // 15 pts vs 5 pts
  });

  describe('difficulty tiers (PlayerSession.botLevel)', () => {
    it('a hard bot sheds a rank whose remaining copies are all accounted for', () => {
      // Card counting off the discard history: all eight 9s are visible, so the
      // lone 9 in hand can never become a set. A normal bot keeps holding it.
      const deadNines = [
        card('9', 'hearts'), card('9', 'spades'), card('9', 'clubs'), card('9', 'diamonds'),
        card('9', 'hearts'), card('9', 'spades'), card('9', 'clubs'),
      ];
      const state = baseState({
        botLevel: 'hard',
        yourHand: [card('9', 'diamonds'), card('4', 'spades'), card('K', 'hearts')],
        discardHistory: deadNines,
        discardPile: [],
      });
      const intent = strategy.decide(state);
      expect(intent.type).to.equal('discard_card');
      expect(intent.card.rank).to.equal('9');
    });

    it('an easy bot still never volunteers a wild', () => {
      // Easy play is imprecise, not suicidal — run it enough times that the
      // randomised branches are all exercised.
      for (let i = 0; i < 60; i += 1) {
        const intent = strategy.decide(baseState({
          botLevel: 'easy',
          yourHand: [
            card('joker', 'joker'), card('2', 'clubs'), card('K', 'hearts'),
            card('9', 'diamonds'), card('4', 'spades'),
          ],
        }));
        if (intent.type === 'discard_card') {
          expect(intent.card.rank).to.not.equal('joker');
          expect(intent.card.rank).to.not.equal('2');
        }
      }
    });
  });
});
