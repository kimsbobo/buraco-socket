/* eslint-env mocha */

/**
 * THE SKIPPED BOT TURN, and its offline twin.
 *
 * `BotStrategy._findAddToMeldAction` can only ever spend a wild when the target
 * meld is EXACTLY six cards: pass 1 refuses every wild (`_joinsAsNatural`), pass
 * 1b filters wilds out of its remainder, and pass 2 is gated on
 * `candidate.length === BRAZILIA_SIZE - 1`. At meld length 3, 4, 5, 7 or 8 a wild
 * in hand is invisible to the planner even though the server would accept it —
 * and when it is the hand's only legal move `decide()` falls through to `wait`,
 * which `BotCoordinator._forceTurnProgress` answers with `_forceAdvanceTurn`: a
 * visible SKIPPED TURN.
 *
 * Measured on the offline twin (`AIPlayer`, identical gate) over 504 rounds /
 * 87,348 bot turns with an independent legality oracle: 603 skips, 600 of them
 * (99.5%) with a legal move waiting, and in every case the same move — one wild
 * onto a team meld. Replayed on the live engine at 55 of them, all 55 were
 * accepted: 44 refilled the hand from the WELL, 11 ended the round with a batida.
 *
 * These tests pin the last-resort branch and its GATE. The gate is the whole
 * design: an unconditional wild add would burn the wilds the brazilia logic is
 * saving, so the branch may only fire when the turn has no other ender at all.
 */

const { expect } = require('chai');
const BotStrategy = require('../../src/bots/BotStrategy');

let nextId = 0;
function card(rank, suit) {
  nextId += 1;
  return { cardId: `w${nextId}`, instanceId: `w${nextId}`, rank, suit, isJoker: rank === 'joker' };
}

/** A four-card heart run: too long for pass 2 (which only fires at six), too
 *  short to be a brazilia. The exact length the planner is blind at. */
const fourHeartRun = () => [card('4', 'hearts'), card('5', 'hearts'), card('6', 'hearts'), card('7', 'hearts')];

/** Six clubs — one card short of a brazilia, so a wild here is worth far more. */
const sixClubRun = () => [
  card('4', 'clubs'), card('5', 'clubs'), card('6', 'clubs'),
  card('7', 'clubs'), card('8', 'clubs'), card('9', 'clubs'),
];

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
    // DIRECT never closes on a discard, so a one-card hand has NO legal discard —
    // the position the skip was measured in.
    professionalWellMode: 'direct',
    yourHand: [],
    playerMelds: {},
    discardPile: [],
    deckCount: 40,
    deadPileCounts: [11, 11],
    pozzettosAvailable: true,
    teamHasTakenPozzetto: false,
    drawnCardRestriction: [],
    ...overrides,
  };
}

describe('BotStrategy — the lone wild the planner could not see', () => {
  const strategy = new BotStrategy();

  it('plays it rather than reporting `wait` and losing the turn', () => {
    const state = baseState({
      yourHand: [card('2', 'clubs')],
      playerMelds: { 1: [fourHeartRun()] },
    });

    // The premise: the server really would accept this add.
    expect(strategy._canAddCardsToMeld(state.playerMelds[1][0], state.yourHand, strategy._context(state)))
      .to.equal(true);
    // ...and there is genuinely nothing else to do.
    expect(strategy._pickDiscard(state, strategy._context(state), state.yourHand)).to.equal(null);

    const intent = strategy.decide(state);
    expect(intent.type).to.equal('add_to_meld');
    expect(intent.cards).to.have.length(1);
    expect(intent.cards[0].rank).to.equal('2');
    expect(intent.targetMeldIndex).to.equal(0);
  });

  it('spends it on the meld it turns into a brazilia, not the short one', () => {
    const intent = strategy.decide(baseState({
      yourHand: [card('2', 'diamonds')],
      playerMelds: { 1: [fourHeartRun(), sixClubRun()] },
    }));
    expect(intent.type).to.equal('add_to_meld');
    expect(intent.targetMeldIndex).to.equal(1);
  });

  it('STRICTLY last resort: a plain discard still wins', () => {
    const intent = strategy.decide(baseState({
      yourHand: [card('2', 'clubs'), card('K', 'diamonds')],
      playerMelds: { 1: [fourHeartRun()] },
    }));
    expect(intent.type).to.equal('discard_card');
    expect(strategy._isWild(intent.card)).to.equal(false);
  });

  it('no team meld to take it: it reports `wait` honestly', () => {
    const intent = strategy.decide(baseState({ yourHand: [card('2', 'clubs')] }));
    expect(intent.type).to.equal('wait');
  });

  it('never offers a joker in a no-joker ruleset', () => {
    const intent = strategy.decide(baseState({
      ruleset: 'classicWithNoJoker',
      yourHand: [card('joker', 'joker')],
      playerMelds: { 1: [fourHeartRun()] },
    }));
    expect(intent.type).to.equal('wait');
  });
});

describe('BotStrategy — a lone-card pile is not taken for a wild the bot will not spend', () => {
  const strategy = new BotStrategy();

  it('declines a one-card pile whose top is a wild that only EXTENDS a meld', () => {
    // The valuation used to short-circuit on "the top card extends one of our
    // melds" for ANY card. For a wild that is a promise the planner does not
    // keep — it takes the wild, holds it, throws its other card back, and the
    // next seat does the same. Traced on the offline twin for 1200 straight
    // turns with 29 cards still in the stock.
    const intent = strategy.decide(baseState({
      hasDrawnCard: false,
      professionalWellMode: 'indirect',
      yourHand: [card('K', 'spades'), card('7', 'diamonds')],
      playerMelds: { 1: [fourHeartRun()] },
      discardPile: [card('2', 'spades')],
    }));
    expect(intent.type).to.equal('draw_card');
  });

  it('but takes it when the wild COMPLETES a brazilia', () => {
    const intent = strategy.decide(baseState({
      hasDrawnCard: false,
      professionalWellMode: 'indirect',
      yourHand: [card('K', 'spades'), card('7', 'diamonds')],
      playerMelds: { 1: [sixClubRun()] },
      discardPile: [card('2', 'spades')],
    }));
    expect(intent.type).to.equal('pick_up_pile');
  });

  it('a DEEP pile whose top is a wild is still taken', () => {
    const intent = strategy.decide(baseState({
      hasDrawnCard: false,
      professionalWellMode: 'indirect',
      yourHand: [card('K', 'spades'), card('7', 'diamonds')],
      playerMelds: { 1: [fourHeartRun()] },
      discardPile: [card('9', 'spades'), card('4', 'clubs'), card('2', 'spades')],
    }));
    expect(intent.type).to.equal('pick_up_pile');
  });
});

describe('BotStrategy — the dead-stock lone-card bar (offline parity anchor)', () => {
  const strategy = new BotStrategy();

  it('declines a LONE card on a dead stock even while the side still owes a well', () => {
    // AIPlayer used to lower this bar with `|| needsWell`, which is what let 40 of
    // 504 simulated offline rounds run forever. The socket has always held it;
    // this pins the reference the client now matches.
    const intent = strategy.decide(baseState({
      hasDrawnCard: false,
      professionalWellMode: 'indirect',
      deckCount: 0,
      yourHand: [card('K', 'spades'), card('7', 'diamonds'), card('5', 'hearts')],
      discardPile: [card('9', 'spades')],
      teamHasTakenPozzetto: false,
    }));
    expect(intent.type).to.equal('draw_card');
  });

  it('takes a TWO-card pile on a dead stock — that is a real continuation', () => {
    const intent = strategy.decide(baseState({
      hasDrawnCard: false,
      professionalWellMode: 'indirect',
      deckCount: 0,
      yourHand: [card('K', 'spades'), card('7', 'diamonds'), card('5', 'hearts')],
      discardPile: [card('9', 'spades'), card('4', 'clubs')],
      teamHasTakenPozzetto: false,
    }));
    expect(intent.type).to.equal('pick_up_pile');
  });
});
